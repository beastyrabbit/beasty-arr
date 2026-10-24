import { hasGermanAudio } from "../../shared/domain.js";
import type {
  ManualImportCandidate,
  QueueItem,
  ResolutionProposal,
} from "../../shared/fixer-types.js";
import { animeTitleConflict } from "../arr/anime-title-match.js";
import { isDiscStreamPath } from "../arr/sample.js";
import type { MediaProbeOk, MediaProbeResult } from "../media/types.js";
import type { InspectionFacts, TargetFacts } from "./inspection.js";

/**
 * Deterministic checks that run after the AI proposed an action. They never
 * make an action happen; they only stop one (turn it into needs_review) when
 * the fixer's own observations contradict it or cannot support it, or make a
 * removal skip a pointless new search. The AI's confidence is not trusted for
 * this.
 */

const RELEASE_YEAR = /(?<!\d)(?:19|20)\d{2}(?!\d)/g;
const EPISODE_CODE = /s\d{1,2}e\d{1,3}/i;
const NAME_SEPARATORS = /[ ._-]+/;
const LEADING_SEPARATOR = /^[ ._-]/;
const TITLE_END = /^(?:german|deutsch|\d{3,4}p)$/i;
const WORD_BOUNDARY = /\s+/;
const EVIDENCE_QUOTE = /"([^"\n]{40,})"/g;

/**
 * The episode title a release names between its SxxEyy code and the language
 * or resolution tag: "Benjamin.Blumchen.S02E02.Ein.ganz.besonderes.Geschenk.German".
 * Scans tokens instead of a backtracking regex, since names are untrusted.
 */
function explicitEpisodeTitle(name: string): string | undefined {
  const code = EPISODE_CODE.exec(name);
  if (!code) return undefined;
  const rest = name.slice(code.index + code[0].length);
  if (!LEADING_SEPARATOR.test(rest)) return undefined;
  const words = rest.split(NAME_SEPARATORS);
  const end = words.findIndex((word) => TITLE_END.test(word));
  const title = words.slice(0, Math.max(end, 0)).filter(Boolean).join(" ");
  return end > 0 && title ? title : undefined;
}

function releaseYears(names: Array<string | undefined>): number[] {
  return [...new Set(names.flatMap((name) => (name?.match(RELEASE_YEAR) ?? []).map(Number)))];
}

function probeOf(facts: InspectionFacts, path: string | undefined): MediaProbeOk | undefined {
  if (!path) return undefined;
  const probe = facts.probes.get(path);
  return probe?.ok ? probe : undefined;
}

function probeFailure(facts: InspectionFacts, path: string): string {
  const probe: MediaProbeResult | undefined = facts.probes.get(path);
  return probe && !probe.ok ? probe.reason : "it was not inspected";
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

type FrameSize = { width?: number; height?: number };

/**
 * Resolution class (2160/1080/720/576/480) from width or height, like Sonarr:
 * a 1920x800 scope film is 1080p and a 1280x960 file is 720p.
 */
function resolutionClass(size: FrameSize | undefined): number | undefined {
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  if (!width && !height) return undefined;
  if (width >= 3200 || height >= 2100) return 2160;
  if (width >= 1800 || height >= 1000) return 1080;
  if (width >= 1200 || height >= 700) return 720;
  // 540 keeps cropped PAL encodes (720x544) in the 576 class.
  if (width >= 1000 || height >= 540) return 576;
  return 480;
}

function arrFrameSize(resolution: string | undefined): FrameSize | undefined {
  const [width, height] = (resolution ?? "").split("x").map(Number);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function currentFrameSize(facts: InspectionFacts, target: TargetFacts): FrameSize | undefined {
  const probed = probeOf(facts, target.currentFile?.path)?.video;
  return probed?.height ? probed : arrFrameSize(target.currentFile?.mediaInfo?.resolution);
}

function currentHasGerman(facts: InspectionFacts, target: TargetFacts): boolean | undefined {
  if (!target.currentFile) return false;
  const probe = probeOf(facts, target.currentFile.path);
  return probe ? probe.hasGermanAudio : undefined;
}

/** Allowed gap between measured and expected runtime. */
function runtimeTolerance(service: "sonarr" | "radarr", expectedMinutes: number): number {
  return service === "radarr"
    ? Math.max(12, expectedMinutes * 0.12)
    : Math.max(8, expectedMinutes * 0.3);
}

function identityReason(proposal: ResolutionProposal): string | undefined {
  const identity = proposal.identity;
  if (identity?.verdict === "confirmed") return undefined;
  return identity
    ? `The AI could not confirm the file is the queued target (identity ${identity.verdict}: ${identity.actualWork || "unknown"}).`
    : "The AI gave no identity assessment.";
}

function parseReason(queueItem: QueueItem, facts: InspectionFacts): string | undefined {
  const matchedId = facts.parse?.matchedId;
  const queuedId = queueItem.service === "radarr" ? queueItem.movieId : queueItem.seriesId;
  if (matchedId === undefined || queuedId === undefined || matchedId === queuedId) {
    return undefined;
  }
  const arr = queueItem.service === "radarr" ? "Radarr" : "Sonarr";
  const matched = facts.parse?.matchedTitle ?? `id ${matchedId}`;
  return `${arr} parses the release name as ${matched}, not the queued target.`;
}

/** One selected file mapped to its targets, with what the fixer observed about it. */
type SelectedFile = {
  name: string;
  candidate: ManualImportCandidate;
  probe: MediaProbeOk | undefined;
  targets: TargetFacts[];
};

/**
 * A series cannot start after its episode aired: a release whose series title
 * carries a later year (Monster.The.Lizzie.Borden.Story.2026 for a 2022
 * episode) is a newer show or season, whatever the arr mapped it to. Nor can
 * it be older than the queued series (Dandivine.2006 for DAN DA DAN, 2024).
 * That side compares with the series' first year, not the episode's: release
 * names of long-running shows keep the year they started (Doctor.Who.2005).
 */
function seriesYearReason(facts: InspectionFacts, file: SelectedFile): string | undefined {
  const seriesYear = facts.parse?.parsedYear;
  if (!seriesYear) return undefined;
  const aired = file.targets.find((target) => target.year && seriesYear > target.year + 1);
  if (aired) {
    return `The release names a series from ${seriesYear}, but ${aired.label} aired in ${aired.year}.`;
  }
  const newer = file.targets.find(
    (target) => target.seriesYear && seriesYear < target.seriesYear - 1,
  );
  if (!newer) return undefined;
  return `The release names a series from ${seriesYear}, but the series of ${newer.label} first aired in ${newer.seriesYear}.`;
}

/** Lowercase letters and digits only, so "DAN DA DAN" and "Dandadan" compare equal. */
function compactTitle(title: string): string {
  return title
    .replaceAll("&", " and ")
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "");
}

const GERMAN_LETTERS: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

/** German scene spelling may use umlauts, expanded vowels or plain vowels. */
function titleForms(title: string): string[] {
  const spelled = title
    .toLowerCase()
    .replaceAll(/[äöüß]/g, (letter) => GERMAN_LETTERS[letter] ?? letter);
  const plain = spelled.replaceAll("ae", "a").replaceAll("oe", "o").replaceAll("ue", "u");
  return [...new Set([compactTitle(title), compactTitle(spelled), compactTitle(plain)])].filter(
    Boolean,
  );
}

/**
 * Whether a title shares nothing with the queued work's known titles.
 * Containment either way counts as shared: "Montana Story Montanaya Donus"
 * is still Montana Story. Missing titles cannot prove a different work.
 */
function unrelatedTitle(
  queueItem: QueueItem,
  targets: TargetFacts[],
  observedTitle: string | undefined,
  alternateTitles: Array<string | undefined> = [],
): boolean {
  if (!observedTitle) return false;
  const queuedTitle = queueItem.service === "radarr" ? queueItem.movieTitle : queueItem.seriesTitle;
  const queued = [
    queuedTitle,
    ...alternateTitles,
    ...targets.flatMap((target) => target.titles),
  ].flatMap((title) => (title ? titleForms(title) : []));
  const parsed = titleForms(observedTitle);
  if (queued.length === 0 || parsed.length === 0) return false;
  return !queued.some((title) =>
    parsed.some((name) => name.includes(title) || title.includes(name)),
  );
}

function yearReason(
  queueItem: QueueItem,
  file: SelectedFile,
  facts: InspectionFacts,
): string | undefined {
  if (queueItem.service === "sonarr") return seriesYearReason(facts, file);
  const movieYear = file.targets[0]?.year ?? queueItem.movieYear;
  // The file's own names describe what was imported; the queue title is only
  // the grabbed release name and must not mask a different year inside it.
  const fileYears = releaseYears([file.candidate.folderName, file.candidate.relativePath]);
  const years = fileYears.length > 0 ? fileYears : releaseYears([queueItem.title]);
  if (!movieYear || years.length === 0 || years.some((year) => Math.abs(year - movieYear) <= 1)) {
    return undefined;
  }
  const label = file.targets[0]?.label ?? `${queueItem.movieTitle ?? "the movie"} (${movieYear})`;
  return `Release year ${years.join("/")} does not match ${label}.`;
}

function runtimeReason(service: QueueItem["service"], file: SelectedFile): string | undefined {
  const { targets, probe } = file;
  if (!probe?.durationSeconds || !targets.every((target) => target.expectedRuntimeMinutes)) {
    return undefined;
  }
  const expected = targets.reduce((sum, target) => sum + (target.expectedRuntimeMinutes ?? 0), 0);
  const measured = probe.durationSeconds / 60;
  if (!expected || Math.abs(measured - expected) <= runtimeTolerance(service, expected)) {
    return undefined;
  }
  const labels = targets.map((target) => target.label).join(" + ");
  return `${file.name} runs ${Math.round(measured)} min, but ${labels} should run about ${expected} min.`;
}

/** German-audio loss and resolution downgrade against each target's current file. */
function replacementReasons(facts: InspectionFacts, file: SelectedFile): string[] {
  const { name, probe } = file;
  return file.targets.flatMap((target) => {
    const reasons: string[] = [];
    const currentPath = target.currentFile?.path;
    if (facts.proberAvailable && currentPath && !probeOf(facts, currentPath)) {
      // Without the library file's real streams, a German-audio loss cannot be ruled out.
      reasons.push(
        `The library file of ${target.label} could not be inspected (${probeFailure(facts, currentPath)}).`,
      );
    }
    const germanNow = currentHasGerman(facts, target);
    if (probe && germanNow && !probe.hasGermanAudio) {
      reasons.push(
        `${name} has no German audio but would replace the German-audio file of ${target.label}.`,
      );
    }
    const before = resolutionClass(currentFrameSize(facts, target));
    const after = resolutionClass(probe?.video);
    const addsGerman = probe?.hasGermanAudio === true && germanNow === false;
    if (before && after && after < before && !addsGerman) {
      reasons.push(
        `${name} is ${after}p and would replace the ${before}p file of ${target.label} without adding German audio.`,
      );
    }
    return reasons;
  });
}

function selectedFiles(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  proposal: ResolutionProposal,
  facts: InspectionFacts,
): SelectedFile[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return proposal.selectedImports.flatMap((selected) => {
    const candidate = byId.get(selected.candidateId);
    if (!candidate) return [];
    const targetIds =
      queueItem.service === "radarr"
        ? [selected.movieId ?? queueItem.movieId ?? 0]
        : selected.episodeIds;
    const targets = targetIds.flatMap((id) => {
      const target = facts.targets.get(id);
      return target ? [target] : [];
    });
    return [
      {
        name: fileName(candidate.path),
        candidate,
        probe: probeOf(facts, candidate.path),
        targets,
      },
    ];
  });
}

/** A Radarr import into a different movie than the queued one is never automatic. */
function otherMovieReason(queueItem: QueueItem, proposal: ResolutionProposal): string | undefined {
  if (queueItem.service !== "radarr" || queueItem.movieId === undefined) return undefined;
  const other = proposal.selectedImports.find(
    (selected) => selected.movieId !== undefined && selected.movieId !== queueItem.movieId,
  );
  if (!other) return undefined;
  return `The file would be imported as movie ${other.movieId}, not the queued movie ${queueItem.movieId}.`;
}

/**
 * The queue mapped the download to another work of the same title (Mary vs
 * Maria); the arr's candidate data was computed against that namesake, so an
 * import waits for a person.
 */
function namesakeReason(queueItem: QueueItem): string | undefined {
  if (queueItem.queueMappedId === undefined) return undefined;
  const arr = queueItem.service === "radarr" ? "Radarr" : "Sonarr";
  return `${arr}'s queue mapped this download to another work of the same title (id ${queueItem.queueMappedId}) than the one it was grabbed for.`;
}

function importReviewReasons(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  proposal: ResolutionProposal,
  facts: InspectionFacts,
): string[] {
  const reasons = [
    identityReason(proposal),
    facts.proberAvailable
      ? undefined
      : "Media inspection is not configured, so the real file could not be checked.",
    namesakeReason(queueItem),
    parseReason(queueItem, facts),
    otherMovieReason(queueItem, proposal),
  ];
  for (const file of selectedFiles(queueItem, candidates, proposal, facts)) {
    if (wrongEpisodePlacement(queueItem, file.candidate, file.targets, facts)) {
      reasons.push(`${file.name} names a different episode or arc than its selected targets.`);
    }
    if (facts.proberAvailable && !file.probe) {
      reasons.push(
        `${file.name} could not be inspected (${probeFailure(facts, file.candidate.path)}).`,
      );
    }
    reasons.push(
      yearReason(queueItem, file, facts),
      runtimeReason(queueItem.service, file),
      ...replacementReasons(facts, file),
    );
  }
  return reasons.filter((reason): reason is string => Boolean(reason));
}

/** The queued targets a candidate file is for; all of them when Sonarr mapped it elsewhere. */
function targetsOfCandidate(
  queueItem: QueueItem,
  candidate: ManualImportCandidate,
  targets: TargetFacts[],
): TargetFacts[] {
  if (queueItem.service === "radarr") return targets;
  const mapped = targets.filter((target) => candidate.episodeIds.includes(target.id));
  return mapped.length > 0 ? mapped : targets;
}

/**
 * Whether a candidate may carry German audio. An inspected file answers it;
 * a file ffprobe rejected as invalid data (Full Metal Panic!'s broken EBML)
 * holds nothing importable; a file that could not be read counts as possibly
 * German; without media inspection the arr's labels are all there is.
 */
function mayHaveGerman(facts: InspectionFacts, candidate: ManualImportCandidate): boolean {
  const probe = facts.probes.get(candidate.path);
  if (probe?.ok) return probe.hasGermanAudio;
  if (probe?.invalid) return false;
  return facts.proberAvailable || hasGermanAudio(candidate.languages);
}

/**
 * A removal must not discard German audio that a queued target lacks in the
 * library. Checked per file, so a mixed season pack cannot hide one episode's
 * only German source behind episodes that already have German.
 */
function germanLossReasons(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  targets: TargetFacts[],
  facts: InspectionFacts,
): string[] {
  return candidates.flatMap((candidate) => {
    if (candidate.isLikelySample || isDiscStreamPath(candidate.path)) return [];
    if (!mayHaveGerman(facts, candidate)) return [];
    const lacking = targetsOfCandidate(queueItem, candidate, targets).filter(
      (target) => currentHasGerman(facts, target) !== true,
    );
    if (lacking.length === 0) return [];
    const labels = lacking.map((target) => target.label).join(", ");
    const name = fileName(candidate.path);
    if (facts.proberAvailable && !probeOf(facts, candidate.path)) {
      return [
        `${name} could not be inspected (${probeFailure(facts, candidate.path)}) and may have German audio that the library copy of ${labels} lacks or could not be checked for; removing it could throw that away.`,
      ];
    }
    return [
      `${name} has German audio that the library copy of ${labels} lacks or could not be checked for; removing it would throw that away.`,
    ];
  });
}

function isFeatureFile(candidate: ManualImportCandidate): boolean {
  return !candidate.isLikelySample && !isDiscStreamPath(candidate.path);
}

/** Placement evidence from read-only lookups, rather than the model's assertion. */
function wrongEpisodePlacement(
  queueItem: QueueItem,
  candidate: ManualImportCandidate,
  targets: TargetFacts[],
  facts: InspectionFacts,
): boolean {
  if (facts.service !== "sonarr" || targets.length === 0) return false;
  const name = [candidate.folderName, candidate.relativePath, fileName(candidate.path)].join(" ");
  const forms = titleForms(name);
  // Only season-bound alternates more specific than the series title name an
  // arc ("Bleach - Sennen Kessen-hen", season 17); a base title, also part of
  // a later season's alternate, is in every file name. Any named arc that
  // fits a queued season clears the file.
  const alternates = facts.series?.alternateTitles ?? [];
  const seasonOf = (alternate: (typeof alternates)[number]) =>
    alternate.seasonNumber ?? alternate.sceneSeasonNumber;
  const seriesForms = titleForms(facts.series?.title ?? "");
  const arcs = alternates.flatMap((alternate) => {
    const season = seasonOf(alternate);
    if (!alternate.title || season === undefined || season < 1) return [];
    const alternateForms = titleForms(alternate.title);
    const broader = [
      ...seriesForms,
      ...alternates
        .filter((other) => other.title && seasonOf(other) !== season)
        .flatMap((other) => titleForms(other.title ?? "")),
    ];
    if (alternateForms.some((title) => broader.some((text) => text.includes(title)))) return [];
    return alternateForms.some((title) => forms.some((text) => text.includes(title)))
      ? [{ season, scene: alternate.seasonNumber === undefined }]
      : [];
  });
  // A scene-season alternate is compared with the episode's XEM scene season.
  const fits = (target: TargetFacts) =>
    arcs.some(
      (arc) =>
        arc.season ===
        (arc.scene ? (target.sceneSeasonNumber ?? target.seasonNumber) : target.seasonNumber),
    );
  if (
    arcs.length > 0 &&
    targets.every((target) => target.seasonNumber !== undefined && !fits(target))
  )
    return true;
  // The catalog also holds episodes of other series the AI looked up (a
  // sequel); only the queued series' titles place a file within it.
  const catalog = [...(facts.episodeCatalog?.values() ?? [])].filter(
    (episode) => episode.seriesId === queueItem.seriesId,
  );
  if (
    targets.every((target) =>
      animeTitleConflict(candidate, { id: target.id, title: target.episodeTitle }, catalog),
    )
  )
    return true;

  // A complete, explicitly named different story, searched across the series,
  // can reject a duplicate over an already-German target even if TVDB lacks it.
  // This cannot discard a missing target's only German copy on an unknown alias.
  // Only a German-original series has a catalog in the release title's
  // language; German releases of English shows name translated titles that an
  // English catalog search cannot find (The.Mentalist.S02E03.Der.rote.Rubin).
  const explicitTitle = explicitEpisodeTitle(candidate.relativePath ?? fileName(candidate.path));
  return Boolean(
    explicitTitle &&
      facts.series?.originalLanguage?.name === "German" &&
      facts.unmatchedEpisodeTitles?.some(
        (query) =>
          query.split(WORD_BOUNDARY).length >= 3 &&
          titleForms(query).some((title) => titleForms(explicitTitle).includes(title)) &&
          targets.every(
            (target) =>
              target.episodeTitle &&
              currentHasGerman(facts, target) === true &&
              !titleForms(target.episodeTitle).some((title) => titleForms(query).includes(title)),
          ),
      ),
  );
}

/** A whole pack placed in another series needs a lookup and real dialogue for every file. */
function otherSeriesPack(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  proposal: ResolutionProposal,
  facts: InspectionFacts,
): boolean {
  const features = candidates.filter(isFeatureFile);
  if (
    queueItem.service !== "sonarr" ||
    features.length < 2 ||
    proposal.identity?.verdict !== "contradicted"
  )
    return false;
  const matches = proposal.identity.episodeMatches ?? [];
  const matchedEpisodes = features.map((candidate) => {
    const match = matches.find((entry) => entry.candidateId === candidate.id);
    const episode = match ? facts.episodeCatalog?.get(match.episodeId) : undefined;
    const dialogue = probeOf(facts, candidate.path)?.subtitleExcerpt?.lines.join(" ");
    if (
      !match ||
      !episode?.seriesId ||
      episode.seriesId === queueItem.seriesId ||
      !episode.overview ||
      !episode.title ||
      !dialogue
    )
      return undefined;
    if (
      match.dialogueQuote.trim().split(WORD_BOUNDARY).length < 6 ||
      !compactTitle(dialogue).includes(compactTitle(match.dialogueQuote))
    )
      return undefined;
    if (
      !proposal.identity?.evidence.some(
        (line) => line.includes(candidate.id) && line.includes(episode.title ?? ""),
      )
    )
      return undefined;
    return episode;
  });
  return (
    matchedEpisodes.every(
      (episode) => episode && episode.seriesId === matchedEpisodes[0]?.seriesId,
    ) && new Set(matchedEpisodes.map((episode) => episode?.id)).size === features.length
  );
}

/**
 * "It is a different work" must be backed by more than the AI's reading: the
 * release year, the runtime, or the arr's own parse naming another title or a
 * title unrelated to the queued one. Mary (2024) checked against Maria (2024)
 * had none of them, and two correct releases were blocklisted. A parse naming
 * the namesake the queue mapped the download to is no evidence: the two works
 * share the title.
 */
function wrongWorkReasons(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  targets: TargetFacts[],
  facts: InspectionFacts,
  proposal: ResolutionProposal,
): string[] {
  if (otherSeriesPack(queueItem, candidates, proposal, facts)) return [];
  // A fetched episode page can settle a title the arr catalog does not know.
  // Require the named story, series and an exact quoted passage cited by URL;
  // a model assertion or a search snippet alone cannot discard wanted German.
  // A page only shows the title exists, not that it is another episode, so
  // this backs a removal only where every target already has German, and
  // never with a quote that also names a target's own title ("Der lange Weg
  // nach Hause (The Long Way Home)" is the same episode, translated).
  const featuresWithTitles = candidates.filter(isFeatureFile);
  // Catalog titles often repeat the series name ("Benjamin Blümchen als
  // Nachtwächter"); a page may name only the rest ("als Nachtwächter").
  const seriesForms = [
    queueItem.seriesTitle ?? "",
    queueItem.title.split(EPISODE_CODE)[0] ?? "",
    ...targets.flatMap((target) => target.titles),
  ]
    .flatMap(titleForms)
    .filter((form) => form.length > 3);
  const targetTitleForms = targets.flatMap((target) =>
    (target.episodeTitle ? titleForms(target.episodeTitle) : []).flatMap((form) => [
      form,
      ...seriesForms.flatMap((series) => {
        const rest = form.startsWith(series) ? form.slice(series.length) : "";
        return rest.length >= 6 ? [rest] : [];
      }),
    ]),
  );
  if (
    queueItem.service === "sonarr" &&
    featuresWithTitles.length > 0 &&
    targets.length > 0 &&
    targets.every((target) => currentHasGerman(facts, target) === true) &&
    featuresWithTitles.every((candidate) => {
      const title = explicitEpisodeTitle(candidate.relativePath ?? fileName(candidate.path));
      if (
        !title ||
        title.split(WORD_BOUNDARY).length < 3 ||
        targets.some(
          (target) =>
            !target.episodeTitle ||
            titleForms(target.episodeTitle).some((form) => titleForms(title).includes(form)),
        )
      )
        return false;
      return facts.webPages?.some(
        (page) =>
          titleForms(title).some((form) =>
            titleForms(page.text).some((text) => text.includes(form)),
          ) &&
          [queueItem.seriesTitle ?? "", queueItem.title.split(EPISODE_CODE)[0] ?? ""]
            .flatMap(titleForms)
            .some(
              (form) =>
                form.length > 3 && titleForms(page.text).some((text) => text.includes(form)),
            ) &&
          // The model picks the quote, so the whole page must not name a
          // target's own story; an episode list naming both goes to review.
          !titleForms(page.text).some((text) =>
            targetTitleForms.some((form) => text.includes(form)),
          ) &&
          proposal.identity?.evidence.some(
            (line) =>
              line.includes(page.url) &&
              titleForms(title).some((form) =>
                titleForms(line).some((text) => text.includes(form)),
              ) &&
              [...line.matchAll(EVIDENCE_QUOTE)].some(
                (match) =>
                  page.text.includes(match[1] ?? "\u0000") &&
                  !titleForms(match[1] ?? "").some((quote) =>
                    targetTitleForms.some((form) => quote.includes(form)),
                  ),
              ),
          ),
      );
    })
  )
    return [];
  // Discarding the download needs every file to fit none of the queued
  // targets: a pack in another order names its files after each other's
  // mapped episodes, yet holds exactly the wanted ones.
  const misplaced = candidates.filter(isFeatureFile);
  if (
    misplaced.length > 0 &&
    misplaced.every((candidate) => wrongEpisodePlacement(queueItem, candidate, targets, facts))
  )
    return [];
  const parsedNamesake =
    queueItem.queueMappedId !== undefined && facts.parse?.matchedId === queueItem.queueMappedId;
  if (!parsedNamesake && parseReason(queueItem, facts)) return [];
  const parsedTitle = facts.parse?.parsedTitle;
  const alternateTitles = facts.series?.alternateTitles?.map((alternate) => alternate.title);
  const unrelatedParse = unrelatedTitle(queueItem, targets, parsedTitle, alternateTitles);
  if (facts.parse?.matchedId === undefined && unrelatedParse) return [];
  // A queue remap need not be a namesake: Countdown: Rousey vs. Carano is
  // a documentary, not the fight it was grabbed for. Require the real file's
  // embedded title to corroborate the unrelated parse; a remapped id alone
  // still cannot justify deleting Mary/Maria or a file with an unknown title.
  const features = candidates.filter(isFeatureFile);
  if (queueItem.service === "radarr" && parsedNamesake && unrelatedParse && features.length === 1) {
    const embeddedTitle = probeOf(facts, features[0]?.path)?.containerTitle;
    if (
      unrelatedTitle(queueItem, targets, embeddedTitle) &&
      titleForms(embeddedTitle ?? "").some((title) => titleForms(parsedTitle ?? "").includes(title))
    ) {
      return [];
    }
  }
  const backed = candidates.filter(isFeatureFile).some((candidate) => {
    const file: SelectedFile = {
      name: fileName(candidate.path),
      candidate,
      probe: probeOf(facts, candidate.path),
      targets: targetsOfCandidate(queueItem, candidate, targets),
    };
    // An episode file not mapped to a target would be measured against the
    // whole pack's summed runtime, so its runtime proves nothing.
    const ownRuntime =
      queueItem.service === "radarr" ||
      targets.some((target) => candidate.episodeIds.includes(target.id));
    return Boolean(
      yearReason(queueItem, file, facts) || (ownRuntime && runtimeReason(queueItem.service, file)),
    );
  });
  if (backed) return [];
  const labels = targets.map((target) => target.label).join(", ") || "the queued target";
  return [
    `The AI judged the download to be a different work, but neither its release year, its runtime nor the arr's own parse of the name contradicts ${labels}.`,
  ];
}

const NOT_AN_UPGRADE =
  /\bnot an? (?:(?:custom format|quality revision|quality|revision) )?upgrade\b/i;

/** Sources in the arrs' quality order within one resolution, best first; anything else ranks last. */
const SOURCE_TIERS: Array<[RegExp, number]> = [
  [/remux/i, 5],
  [/blu-?ray|bdrip|brrip/i, 4],
  [/web-?dl/i, 3],
  [/webrip/i, 2],
  [/hdtv|raw-hd/i, 1],
];
const QUALITY_RESOLUTION = /(\d{3,4})p\b/i;

/** Source tier and resolution of an arr quality name ("Remux-1080p", "WEBDL-720p", "SDTV"). */
function arrQuality(name: string | undefined): { tier: number; resolution?: number } | undefined {
  if (!name) return undefined;
  const tier = SOURCE_TIERS.find(([pattern]) => pattern.test(name))?.[1] ?? 0;
  return { tier, resolution: Number(QUALITY_RESOLUTION.exec(name)?.[1]) || undefined };
}

/**
 * The candidate's arr quality is a lower source than the library file's at the
 * same resolution (WEBDL-1080p against Remux-1080p). Neither arr upgrades to a
 * lower quality on custom-format score alone, so its score proves nothing.
 */
function lowerSourceThanLibrary(
  candidate: ManualImportCandidate,
  target: TargetFacts,
  after: number | undefined,
  before: number | undefined,
): boolean {
  const next = arrQuality(candidate.qualityLabel);
  const now = arrQuality(target.currentFile?.quality);
  if (!next || !now || next.tier >= now.tier) return false;
  const resolution = next.resolution ?? after;
  return resolution !== undefined && resolution === (now.resolution ?? before);
}

/**
 * A removal must not throw away a German file that may be an upgrade: the arr
 * scores it higher than the library file (Benjamin Blümchen S01E03: 11700
 * against -23300), or its labels missed the German track, so its scores and
 * rejections were computed without it. The arr's own "not an upgrade" counts
 * only when its labels saw the German track; a lower resolution never upgrades,
 * and neither does a lower source at the same resolution (A Nightmare on Elm
 * Street 4: WEBDL-1080p at 13450 against a Remux-1080p at 11700).
 */
function upgradeLossReasons(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  targets: TargetFacts[],
  facts: InspectionFacts,
): string[] {
  const arr = queueItem.service === "radarr" ? "Radarr" : "Sonarr";
  return candidates.filter(isFeatureFile).flatMap((candidate) => {
    if (!mayHaveGerman(facts, candidate)) return [];
    const name = fileName(candidate.path);
    const after = resolutionClass(probeOf(facts, candidate.path)?.video);
    // A target without a file is germanLossReasons' case.
    const comparable = targetsOfCandidate(queueItem, candidate, targets).filter((target) => {
      if (!target.currentFile) return false;
      const before = resolutionClass(currentFrameSize(facts, target));
      if (before && after && after < before) return false;
      return !lowerSourceThanLibrary(candidate, target, after, before);
    });
    if (comparable.length === 0) return [];
    if (candidate.germanFromInspection) {
      return [
        `${name} has German audio that ${arr}'s labels missed, so ${arr}'s scores ignore it and it may be an upgrade.`,
      ];
    }
    if (candidate.rejections.some((rejection) => NOT_AN_UPGRADE.test(rejection))) return [];
    const score = candidate.customFormatScore;
    return comparable.flatMap((target) => {
      const now = target.currentFile?.customFormatScore;
      if (score !== undefined && now !== undefined && score <= now) return [];
      return [
        `${name} keeps German audio and ${arr} scores it ${score ?? "unknown"} against ${now ?? "unknown"} for the library file of ${target.label}, so it may be an upgrade.`,
      ];
    });
  });
}

function removalReviewReasons(
  queueItem: QueueItem,
  candidates: ManualImportCandidate[],
  proposal: ResolutionProposal,
  facts: InspectionFacts,
): string[] {
  // Without inspection, an untagged German track looks like no German at all,
  // so the German-loss and upgrade-loss checks below cannot be trusted.
  const reasons: string[] = facts.proberAvailable
    ? []
    : ["Media inspection is not configured, so the real files could not be checked."];
  const targets = queuedTargets(queueItem, facts);
  const lossReasons = [
    ...germanLossReasons(queueItem, candidates, targets, facts),
    ...upgradeLossReasons(queueItem, candidates, targets, facts),
  ];
  if (proposal.identity?.verdict !== "contradicted") return [...reasons, ...lossReasons];
  // "A different work" needs backing only when the removal could lose
  // something: German or an upgrade for a target, or a target's only file.
  // Removing an English 720p copy over a 1080p library file (Paw Patrol)
  // loses nothing, whatever the download really is.
  const canLose =
    lossReasons.length > 0 || targets.length === 0 || targets.some((target) => !target.currentFile);
  return canLose
    ? [...reasons, ...wrongWorkReasons(queueItem, candidates, targets, facts, proposal)]
    : reasons;
}

function queuedTargets(queueItem: QueueItem, facts: InspectionFacts): TargetFacts[] {
  const queuedIds = queueItem.service === "radarr" ? [queueItem.movieId] : queueItem.episodeIds;
  return queuedIds.flatMap((id) => {
    const target = id === undefined ? undefined : facts.targets.get(id);
    return target ? [target] : [];
  });
}

/**
 * A new search cannot bring German audio the library files of every queued
 * target already have, so a removal asking for one goes ahead without it
 * (Clevatess S02E12) instead of waiting for a person, whatever the AI's
 * identity verdict.
 */
function withoutNeedlessSearch(
  queueItem: QueueItem,
  proposal: ResolutionProposal,
  facts: InspectionFacts,
): ResolutionProposal {
  const options = proposal.queueRemovalOptions;
  if (!options || options.skipRedownload) return proposal;
  // Every queued target must be loaded: a target missing from the facts may
  // be the one that still needs the search.
  const queuedIds = queueItem.service === "radarr" ? [queueItem.movieId] : queueItem.episodeIds;
  const targets = queuedTargets(queueItem, facts);
  const libraryHasGerman =
    targets.length > 0 &&
    targets.length === queuedIds.length &&
    targets.every((target) => currentHasGerman(facts, target) === true);
  if (!libraryHasGerman) return proposal;
  return {
    ...proposal,
    queueRemovalOptions: { ...options, skipRedownload: true },
    warnings: [
      ...proposal.warnings,
      "The removal asked for a new search although the library file already has German audio; the fixer turned the search off.",
    ],
  };
}

/**
 * Applies the guards; a blocked proposal becomes needs_review with reviewReasons.
 * The one correction they make, turning off a needless search, only makes a
 * removal less aggressive.
 */
export function applyGuards(input: {
  queueItem: QueueItem;
  candidates: ManualImportCandidate[];
  proposal: ResolutionProposal;
  facts: InspectionFacts;
}): ResolutionProposal {
  const { queueItem, candidates, facts } = input;
  let proposal = input.proposal;
  let reasons: string[] = [];
  if (proposal.action === "import_candidates") {
    reasons = importReviewReasons(queueItem, candidates, proposal, facts);
  } else if (proposal.action === "remove_queue_item") {
    proposal = withoutNeedlessSearch(queueItem, proposal, facts);
    reasons = removalReviewReasons(queueItem, candidates, proposal, facts);
  }
  if (reasons.length === 0) return proposal;
  return {
    ...proposal,
    action: "needs_review",
    reason: `Held for review: ${reasons[0]}`,
    reviewReasons: [...(proposal.reviewReasons ?? []), ...reasons],
  };
}
