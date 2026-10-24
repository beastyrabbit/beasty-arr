import type { SonarrClient, SonarrEpisodeRecord } from "./sonarr-client.js";

/** ManualImport deletes whole existing files, including all their episode associations. */
export async function replacementFileSets(
  client: Pick<SonarrClient, "getEpisodes">,
  episodes: SonarrEpisodeRecord[],
) {
  const fileIds = new Set(
    episodes.flatMap((episode) => {
      const id = episode.episodeFileId ?? episode.episodeFile?.id;
      return id ? [id] : [];
    }),
  );
  if (fileIds.size === 0) return [];
  const seriesIds = [...new Set(episodes.map((e) => e.seriesId ?? e.series?.id))];
  if (seriesIds.some((id) => !id)) {
    throw new Error("Cannot verify shared episode files without their series id.");
  }
  const allEpisodes = (
    await Promise.all(seriesIds.map((seriesId) => client.getEpisodes({ seriesId })))
  ).flat();
  return [...fileIds].map((episodeFileId) => {
    const members = allEpisodes.filter(
      (episode) => (episode.episodeFileId ?? episode.episodeFile?.id) === episodeFileId,
    );
    if (members.length === 0) {
      throw new Error(`Cannot verify episodes sharing library file ${episodeFileId}.`);
    }
    return {
      episodeFileId,
      episodeIds: members.flatMap((episode) => (episode.id ? [episode.id] : [])),
    };
  });
}
