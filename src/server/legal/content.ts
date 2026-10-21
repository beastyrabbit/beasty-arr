// Verified rollout templates, with site-specific processing blocks kept bilingual.
export type LegalLanguage = "de" | "en";
type SectionText = { heading: string; body: string };
type BilingualSection = { id: string; de: SectionText; en: SectionText };

// Replace these five shared values after verification; the readiness test must then pass.
const TMDB_ENTITY = "[[TMDB_ENTITY]]";
const OPENAI_ENTITY = "[[OPENAI_ENTITY]]";
const OPENAI_TRANSFER = "[[OPENAI_TRANSFER]]";
const PANGOLIN_COOKIE = "[[PANGOLIN_COOKIE]]";
const PANGOLIN_COOKIE_DURATION = "[[PANGOLIN_COOKIE_DURATION]]";

export const legalNoticeSections: readonly BilingualSection[] = [
  {
    id: "provider",
    de: {
      heading: "Anbieter",
      body: `<p>Tobias Heer<br>
c/o Impressumservice Dein-Impressum<br>
Stettiner Str. 41<br>
35410 Hungen<br>
Deutschland</p>`,
    },
    en: {
      heading: "Provider",
      body: `<p>Tobias Heer<br>
c/o Impressumservice Dein-Impressum<br>
Stettiner Str. 41<br>
35410 Hungen<br>
Germany</p>`,
    },
  },
  {
    id: "contact",
    de: {
      heading: "Kontakt",
      body: `<p>E-Mail: <a href="mailto:impressum-beasty-arr@heerlab.com">impressum-beasty-arr@heerlab.com</a><br>
Kontaktformular: <a href="https://beastyrabbit.com/kontakt?from=beasty-arr">beastyrabbit.com/kontakt</a></p>`,
    },
    en: {
      heading: "Contact",
      body: `<p>E-mail: <a href="mailto:impressum-beasty-arr@heerlab.com">impressum-beasty-arr@heerlab.com</a><br>
Contact form: <a href="https://beastyrabbit.com/kontakt?from=beasty-arr">beastyrabbit.com/kontakt</a></p>`,
    },
  },
  {
    id: "note",
    de: {
      heading: "Hinweis",
      body: `<p>beasty-arr ist ein privates, nicht-kommerzielles Projekt.</p>`,
    },
    en: {
      heading: "Note",
      body: `<p>beasty-arr is a private, non-commercial project.</p>`,
    },
  },
  {
    id: "privacy",
    de: {
      heading: "Datenschutz",
      body: `<p>Informationen zur Verarbeitung personenbezogener Daten finden Sie in der <a href="/datenschutz">Datenschutzerklärung</a>.</p>`,
    },
    en: {
      heading: "Privacy",
      body: `<p>For information on how personal data is processed, see the <a href="/privacy">Privacy Policy</a>.</p>`,
    },
  },
];

export const privacySections: readonly BilingualSection[] = [
  {
    id: "controller",
    de: {
      heading: "Verantwortlicher",
      body: `<p>Verantwortlich für die Verarbeitung personenbezogener Daten auf https://beasty-arr.heerlab.com ist:</p>
<p>Tobias Heer<br>
c/o Impressumservice Dein-Impressum<br>
Stettiner Str. 41<br>
35410 Hungen<br>
Deutschland</p>
<p>E-Mail: <a href="mailto:datenschutz-beasty-arr@heerlab.com">datenschutz-beasty-arr@heerlab.com</a></p>
<p>Ein Datenschutzbeauftragter ist nicht bestellt, da hierzu keine gesetzliche Pflicht besteht.</p>`,
    },
    en: {
      heading: "Controller",
      body: `<p>The controller responsible for processing personal data on https://beasty-arr.heerlab.com is:</p>
<p>Tobias Heer<br>
c/o Impressumservice Dein-Impressum<br>
Stettiner Str. 41<br>
35410 Hungen<br>
Germany</p>
<p>E-mail: <a href="mailto:datenschutz-beasty-arr@heerlab.com">datenschutz-beasty-arr@heerlab.com</a></p>
<p>No data protection officer has been appointed, as there is no legal obligation to do so.</p>`,
    },
  },
  {
    id: "overview",
    de: {
      heading: "Überblick",
      body: `<p>Diese Erklärung informiert darüber, welche personenbezogenen Daten bei der Nutzung von beasty-arr verarbeitet werden, zu welchen Zwecken, auf welcher Rechtsgrundlage und wie lange. beasty-arr ist ein privates, nicht-kommerzielles Projekt. beasty-arr ist ein internes Werkzeug, mit dem der Verantwortliche deutsch synchronisierte Fassungen für die Serien und Filme in seiner eigenen Sonarr-/Radarr-Mediathek findet. Die Anwendung ist nach Anmeldung ausschließlich für den Verantwortlichen selbst zugänglich; öffentlich ohne Anmeldung erreichbar sind nur das Impressum und diese Datenschutzerklärung.</p>
<p>Personenbezogene Daten werden nicht verkauft und nicht für Werbung verwendet. Eine automatisierte Entscheidungsfindung einschließlich Profiling im Sinne von Art. 22 DSGVO findet nicht statt.</p>`,
    },
    en: {
      heading: "Overview",
      body: `<p>This policy explains which personal data is processed when you use beasty-arr, for what purposes, on which legal basis, and for how long. beasty-arr is a private, non-commercial project. beasty-arr is an internal tool with which the controller finds German-dubbed versions of the series and films in his own Sonarr/Radarr media library. After sign-in, the application is accessible only to the controller himself; only the legal notice and this privacy policy are publicly accessible without sign-in.</p>
<p>Personal data is not sold and not used for advertising. There is no automated decision-making, including profiling, within the meaning of Art. 22 GDPR.</p>`,
    },
  },
  {
    id: "hosting",
    de: {
      heading: "Hosting und Bereitstellung",
      body: `<p>beasty-arr läuft auf eigener Server-Infrastruktur des Verantwortlichen in Deutschland. Aufrufe aus dem Internet erreichen die Anwendung über einen Reverse-Proxy auf einem virtuellen Server der netcup GmbH, Emmy-Noether-Straße 10, 76131 Karlsruhe, Deutschland (Rechenzentrum in Nürnberg). netcup verarbeitet die Daten dabei als Auftragsverarbeiter; mit netcup besteht ein Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO. Die Verbindung ist bis zum Reverse-Proxy TLS-verschlüsselt und wird von dort durch einen verschlüsselten Tunnel an die eigene Infrastruktur weitergeleitet.</p>
<p>Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in einer sicheren und zuverlässigen Bereitstellung der Website.</p>
<p>Die in SQLite auf einem Longhorn-Volume gespeicherten Daten werden lokal und als externe Sicherungskopien in einem Rechenzentrum in Deutschland gesichert. Sicherungskopien werden derzeit ohne feste Löschfrist aufbewahrt. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse ist der Schutz vor Datenverlust.</p>`,
    },
    en: {
      heading: "Hosting and delivery",
      body: `<p>beasty-arr runs on the controller's own server infrastructure in Germany. Requests from the internet reach the application through a reverse proxy on a virtual server operated by netcup GmbH, Emmy-Noether-Straße 10, 76131 Karlsruhe, Germany (data center in Nuremberg). netcup processes the data as a processor under a data processing agreement pursuant to Art. 28 GDPR. The connection is TLS-encrypted up to the reverse proxy and forwarded from there to the controller's infrastructure through an encrypted tunnel.</p>
<p>The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the secure and reliable provision of the website.</p>
<p>The data stored in SQLite on a Longhorn volume is backed up locally and as offsite backup copies in a data center in Germany. Backup copies are currently kept without a fixed deletion period. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is protection against data loss.</p>`,
    },
  },
  {
    id: "logs",
    de: {
      heading: "Server-Logfiles",
      body: `<p>Bei jedem Aufruf speichert der Reverse-Proxy automatisch folgende Daten:</p>
<ul><li>IP-Adresse des anfragenden Geräts</li><li>Datum und Uhrzeit des Zugriffs</li><li>aufgerufene Adresse (Pfad einschließlich Parameter), HTTP-Methode und Protokoll</li><li>HTTP-Statuscode, übertragene Datenmenge und Antwortzeit</li><li>Browser-Kennung (User-Agent)</li><li>verwendete TLS-Version und Verschlüsselung</li><li>angesprochener Dienst</li></ul>
<p>Die Header Cookie und Authorization werden geschwärzt. URL-Pfade und Abfrageparameter werden protokolliert.</p>
<p>Die Daten dienen dem Betrieb, der Fehleranalyse und der Abwehr von Angriffen und Missbrauch. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in Stabilität und Sicherheit des Angebots. Die Logfiles werden nach 14 Tagen automatisch gelöscht.</p>
<p>Pangolin speichert zusätzlich HTTP-Anfragen für 14 Tage, Netzwerkprotokolle für 30 Tage und Anmeldeprotokolle für 90 Tage (siehe Abschnitt Anmeldung). Diese Protokolle enthalten Verbindungs- und Zugriffsdaten, insbesondere IP-Adresse, Zeitpunkt und angefragte Adresse, bei Anmeldungen auch die dort beschriebenen Identitätsdaten. Sie dienen dem Betrieb, der Fehleranalyse und der Zugangssicherheit auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO.</p>
<p>Das eigene Anwendungsprotokoll (Fastify/pino, Container-Standardausgabe) enthält IP-Adresse, Zeitpunkt, HTTP-Methode, angefragte URL einschließlich Abfrageparametern, Statuscode und Antwortzeit. Der Webhook-Parameter token wird aus der protokollierten URL entfernt. Zweck sind Betrieb und Fehleranalyse; Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO, mit dem berechtigten Interesse an einem zuverlässigen Betrieb. Diese Protokolle werden nicht zentral gesammelt. Sie bestehen nur als kurzlebige Kubernetes-Containerprotokolle, werden rotiert und beim Ersetzen des Containers verworfen; eine feste Frist in Tagen besteht nicht.</p>`,
    },
    en: {
      heading: "Server log files",
      body: `<p>For every request, the reverse proxy automatically stores the following data:</p>
<ul><li>IP address of the requesting device</li><li>date and time of access</li><li>requested address (path including parameters), HTTP method and protocol</li><li>HTTP status code, amount of data transferred, and response time</li><li>browser identifier (user agent)</li><li>TLS version and cipher used</li><li>target service</li></ul>
<p>The Cookie and Authorization headers are redacted. URL paths and query parameters are logged.</p>
<p>This data is used to operate the site, analyse errors, and defend against attacks and abuse. The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the stability and security of the service. Log files are deleted automatically after 14 days.</p>
<p>Pangolin also retains HTTP request logs for 14 days, network logs for 30 days and authentication logs for 90 days (see the sign-in section). These logs contain connection and access data, in particular IP address, time and requested address, and, for sign-ins, the identity data described there. They serve operation, troubleshooting and access security on the basis of Art. 6(1)(f) GDPR.</p>
<p>The application’s own log (Fastify/pino, container standard output) contains IP address, time, HTTP method, requested URL including query parameters, status code and response time. The webhook token parameter is removed from the logged URL. The purposes are operation and troubleshooting; the legal basis is Art. 6(1)(f) GDPR, with a legitimate interest in reliable operation. These logs are not collected centrally. They exist only as short-lived Kubernetes container logs, are rotated and discarded when the container is replaced; there is no fixed period in days.</p>`,
    },
  },
  {
    id: "crowdsec",
    de: {
      heading: "Schutz vor Angriffen (CrowdSec)",
      body: `<p>Zum Schutz vor Angriffen wertet die Sicherheitssoftware CrowdSec die Server-Logfiles automatisch aus und sperrt IP-Adressen, von denen erkennbar Angriffe ausgehen (zum Beispiel massenhafte Anmeldeversuche oder das Ausspähen von Schwachstellen). Erkennt CrowdSec einen Angriff, werden die IP-Adresse, der Zeitpunkt und die Art des Angriffs an die CrowdSec SAS, 20 rue Maurice Arnoux, 92120 Montrouge, Frankreich, übermittelt. CrowdSec nutzt diese Meldungen für eine gemeinsame Sperrliste, die Angriffe auf viele Server abwehrt. Bei normalem Surfen werden keine Daten an CrowdSec übermittelt.</p>
<p>Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt im Schutz der Website und ihrer Nutzer vor Angriffen.</p>
<p>Für diese Verarbeitung sind der Verantwortliche und CrowdSec nach Angaben von CrowdSec gemeinsam verantwortlich (Art. 26 DSGVO): CrowdSec ist für den Betrieb seiner zentralen Dienste und Sperrlisten verantwortlich, der Verantwortliche für den Einsatz auf diesem Server. Sie können Ihre Rechte gegenüber beiden geltend machen, bei CrowdSec unter <a href="mailto:dpo@crowdsec.net">dpo@crowdsec.net</a>. CrowdSec kann die gemeldeten Daten an Mitglieder und Partner seines Netzwerks weitergeben. Übermittlungen in Länder außerhalb der EU erfolgen nach Angaben von CrowdSec auf Grundlage von Standardvertragsklauseln der EU-Kommission (Art. 46 Abs. 2 lit. c DSGVO).</p>
<p>Vollständige IP-Adressen werden grundsätzlich höchstens drei Monate gespeichert und anschließend schrittweise verallgemeinert. Für bestimmte Angriffsanalysen und Trainingszwecke nennt CrowdSec Ausnahmen von bis zu einem Jahr vor der Anonymisierung. Details: <a href="https://www.crowdsec.net/privacy-policy">crowdsec.net/privacy-policy</a>.</p>`,
    },
    en: {
      heading: "Protection against attacks (CrowdSec)",
      body: `<p>To protect against attacks, the security software CrowdSec automatically analyses the server log files and blocks IP addresses that are clearly the source of attacks (for example mass login attempts or scanning for vulnerabilities). When CrowdSec detects an attack, the IP address, time and type of attack are sent to CrowdSec SAS, 20 rue Maurice Arnoux, 92120 Montrouge, France. CrowdSec uses these reports for a shared blocklist that protects many servers. No data is sent to CrowdSec during normal browsing.</p>
<p>The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is protecting the website and its users from attacks.</p>
<p>According to CrowdSec, the controller and CrowdSec are jointly responsible for this processing (Art. 26 GDPR): CrowdSec is responsible for operating its central services and blocklists, the controller for its use on this server. You can exercise your rights against either of them; CrowdSec can be reached at <a href="mailto:dpo@crowdsec.net">dpo@crowdsec.net</a>. CrowdSec may pass the reported data on to members and partners of its network. According to CrowdSec, transfers to countries outside the EU are based on the European Commission's Standard Contractual Clauses (Art. 46(2)(c) GDPR).</p>
<p>Full IP addresses are generally retained for no more than three months and then progressively generalised. CrowdSec describes exceptions of up to one year before anonymisation for certain attack analyses and training purposes. Details: <a href="https://www.crowdsec.net/privacy-policy">crowdsec.net/privacy-policy</a>.</p>`,
    },
  },
  {
    id: "sso",
    de: {
      heading: "Anmeldung (Single Sign-On)",
      body: `<p>beasty-arr ist nur für eingeladene Personen zugänglich. Die Anmeldung erfolgt über den Reverse-Proxy Pangolin mit dem selbst betriebenen Identitätsdienst Pocket-ID auf der eigenen Infrastruktur. Dabei werden Benutzername, E-Mail-Adresse, Gruppenzugehörigkeit, Zeitpunkt der Anmeldung und IP-Adresse verarbeitet. Nach der Anmeldung setzt Pangolin ein Sitzungs-Cookie, das für den Zugang technisch erforderlich ist.</p>
<p>In der Praxis ist der Zugang durch Rollen auf den Verantwortlichen selbst beschränkt. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt darin, den Zugang auf berechtigte Personen zu beschränken.</p>
<p>Das Benutzerkonto in Pocket-ID und Pangolin besteht, solange der Zugang eingeräumt ist, und wird auf Anfrage oder nach Entzug des Zugangs gelöscht. Anmeldeprotokolle werden nach 90 Tagen gelöscht. Sicherungskopien der Datenbanken werden derzeit ohne feste Löschfrist aufbewahrt (siehe Abschnitt Hosting/Backups).</p>`,
    },
    en: {
      heading: "Sign-in (single sign-on)",
      body: `<p>beasty-arr is only accessible to invited people. Sign-in is handled by the Pangolin reverse proxy with Pocket-ID, an identity service self-hosted on the controller's infrastructure. This processes your user name, e-mail address, group membership, time of sign-in and IP address. After sign-in, Pangolin sets a session cookie that is technically required for access.</p>
<p>In practice, role restrictions limit access to the controller himself. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is restricting access to authorised persons.</p>
<p>The user account in Pocket-ID and Pangolin exists for as long as access is granted and is deleted on request or after access is withdrawn. Authentication logs are deleted after 90 days. Backup copies of the databases are currently kept without a fixed deletion period (see the Hosting/Backups section).</p>`,
    },
  },
  {
    id: "app-data",
    de: {
      heading: "In der Anwendung gespeicherte Daten",
      body: `<p>beasty-arr hat keine eigenen Nutzerkonten. Die Datenbank auf der eigenen Infrastruktur speichert eine Kopie der Bibliotheksdaten aus Sonarr/Radarr (Titel, IDs, Sprachen, Dateipfade), Such- und Aktivitätsverläufe, Ergebnisse von KI-Analysen einschließlich ihrer Begründungen und vom Verantwortlichen eingegebene Notizen. Als Datenquellen dienen die selbst betriebenen Dienste Sonarr, Radarr und Prowlarr im Homelab; sie sind keine externen Dritten. Dies betrifft ausschließlich die eigene Nutzung des Verantwortlichen und dient der Verwaltung seiner Mediathek. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in dieser Medienverwaltung.</p>
<p>Diese Datensätze werden derzeit ohne feste Löschfrist aufbewahrt. Dies umfasst Aktivitäten, Suchversuche, KI-Bewertungen, Fixer-Analysen und -Verläufe, manuelle Anfragen und Statistiken. Einige Bibliothekseinträge werden entfernt, wenn sie aus Sonarr/Radarr verschwinden. Budget-Snapshots werden ungefähr 30 Tage aufbewahrt.</p>`,
    },
    en: {
      heading: "Data stored in the application",
      body: `<p>beasty-arr has no user accounts of its own. Its database on the controller's own infrastructure stores a copy of library data from Sonarr/Radarr (titles, IDs, languages, file paths), search and activity history, AI analysis results including their reasoning, and notes entered by the controller. The data sources are the self-hosted Sonarr, Radarr and Prowlarr services in the homelab; these are not external third parties. This concerns only the controller's own use and serves the management of his media library. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is this media management.</p>
<p>These records are currently kept without a fixed deletion period. This includes activity, search attempts, AI verdicts, Fixer analyses and history, manual requests and statistics. Some library entries are removed when they disappear from Sonarr/Radarr. Budget snapshots are retained for approximately 30 days.</p>`,
    },
  },
  // TODO(user-decision): posters — the US transfer paragraph has no verified safeguard.
  {
    id: "posters",
    de: {
      heading: "Vorschaubilder (TheTVDB und TMDB)",
      body: `<p>Nach der Anmeldung lädt der Browser Vorschaubilder direkt von artworks.thetvdb.com und image.tmdb.org. Dabei erhalten die Anbieter die IP-Adresse des Browsers, die angefragte Bildadresse und übliche Browser-Header. Anbieter von TheTVDB ist Whip Networks, Inc., laut seiner <a href="https://www.thetvdb.com/privacy-policy">Datenschutzerklärung</a> ein US-Unternehmen. Anbieter von TMDB ist ${TMDB_ENTITY}; siehe dessen <a href="https://www.themoviedb.org/privacy-policy">Datenschutzerklärung</a>.</p>
<p>Die Übermittlung an TheTVDB erfolgt in die USA und ist nicht durch eine Zertifizierung unter dem EU-US Data Privacy Framework abgedeckt. Ein Angemessenheitsbeschluss oder geeignete Garantien für diese Übermittlung liegen nach derzeitigem Kenntnisstand nicht vor.</p>
<p>Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse ist die Anzeige von Vorschaubildern. Die Speicherdauer bei den Anbietern richtet sich nach deren Datenschutzbestimmungen. Dies betrifft nur den angemeldeten Verantwortlichen.</p>`,
    },
    en: {
      heading: "Poster images",
      body: `<p>After sign-in, the browser loads poster images directly from artworks.thetvdb.com and image.tmdb.org. The providers receive the browser's IP address, the requested image address and usual browser headers. TheTVDB is provided by Whip Networks, Inc., a US company according to its <a href="https://www.thetvdb.com/privacy-policy">privacy policy</a>. TMDB's provider is ${TMDB_ENTITY}; see its <a href="https://www.themoviedb.org/privacy-policy">privacy policy</a>.</p>
<p>The transfer to TheTVDB is to the USA and is not covered by certification under the EU-US Data Privacy Framework. To the controller's current knowledge, there is no adequacy decision or appropriate safeguard for this transfer.</p>
<p>The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is displaying artwork. Provider-side retention follows their privacy policies. This affects only the signed-in controller.</p>`,
    },
  },
  // TODO(verify): openai
  {
    id: "openai",
    de: {
      heading: "KI-Analyse (OpenAI)",
      body: `<p>Zur Prüfung deutscher Synchronfassungen und zur Reparatur blockierter Importe sendet der Server Daten an den Codex-Dienst von OpenAI über das eigene ChatGPT-Konto des Verantwortlichen (chatgpt.com, Anmeldung über auth.openai.com). Übermittelt werden Titel, Erscheinungsjahre, externe IDs, Staffeldaten und Rechercheergebnisse. Bei Importreparaturen gehören dazu auch Datei- und Ordnernamen, Release-Namen, Dateipfade, Statusmeldungen, technische Dateiinformationen und optional Untertitelauszüge und NFO-IDs. Daten von Besuchern werden nicht übermittelt.</p>
<p>Anbieter: ${OPENAI_ENTITY}. Drittlandübermittlung: ${OPENAI_TRANSFER}. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in der Prüfung von Synchronfassungen und der Behebung von Importproblemen. Weitere Informationen: <a href="https://openai.com/policies/">OpenAI-Richtlinien</a>.</p>`,
    },
    en: {
      heading: "AI analysis (OpenAI)",
      body: `<p>For German-dub checks and stuck-import repair, the server sends data to OpenAI's Codex service through the controller's own ChatGPT account (chatgpt.com, sign-in via auth.openai.com). The data includes titles, years, external IDs, season data and research results. Import repair also includes file and folder names, release names, file paths, status messages, technical file information and optionally subtitle excerpts and NFO IDs. No data of visitors is sent.</p>
<p>Provider: ${OPENAI_ENTITY}. Third-country transfer: ${OPENAI_TRANSFER}. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is checking dubbed versions and resolving import problems. Further information: <a href="https://openai.com/policies/">OpenAI policies</a>.</p>`,
    },
  },
  {
    id: "indexers",
    de: {
      heading: "Indexer (über Prowlarr)",
      body: `<p>Um Releases zu suchen, senden die selbst betriebenen Dienste Sonarr/Radarr/Prowlarr Suchanfragen (Titel, IDs) mit den eigenen Indexer-Konten des Verantwortlichen an die von ihm konfigurierten Usenet-/Torrent-Indexer. Diese erhalten die IP-Adresse des Homelabs, die Zugangsdaten des Kontos und die Suchanfragen, keine Daten von Besuchern. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in der Suche nach passenden Releases für die eigene Mediathek.</p>`,
    },
    en: {
      heading: "Indexers (via Prowlarr)",
      body: `<p>To search for releases, the self-hosted Sonarr/Radarr/Prowlarr services send search queries (titles, IDs), using the controller's own indexer accounts, to the Usenet/torrent indexers configured by the controller. They receive the homelab's IP address, account credentials and search queries, with no data of visitors. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is finding suitable releases for the controller's own media library.</p>`,
    },
  },
  {
    id: "public-sources",
    de: {
      heading: "Öffentliche Informationsquellen",
      body: `<p>Um zu prüfen, ob eine deutsche Synchronfassung existiert, ruft der Server öffentliche Webseiten und Daten ab, insbesondere Wikidata (query.wikidata.org), Wikipedia, Synchronkartei, fernsehserien.de, JustWatch und öffentliche Titelseiten von Streamingdiensten (zum Beispiel Netflix und Prime Video). Die KI-Analyse kann zusätzlich weitere von ihr gefundene öffentliche Seiten abrufen. Für die Liste verfügbarer KI-Modelle wird der Modellkatalog von pi.dev (Earendil Inc.) abgerufen.</p>
<p>Diese Anfragen kommen vom Server. Die Anbieter sehen nur die IP-Adresse des Homelabs und die angefragte Adresse (Titel/IDs), keine Daten von Besuchern und keine Cookies. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in der Recherche zu Synchronfassungen und der Bereitstellung der Modellauswahl.</p>`,
    },
    en: {
      heading: "Public information sources",
      body: `<p>To check whether a German dub exists, the server retrieves public web pages and data, in particular Wikidata (query.wikidata.org), Wikipedia, Synchronkartei, fernsehserien.de, JustWatch and public title pages of streaming services (for example Netflix and Prime Video). The AI analysis can also retrieve other public pages it finds. The model catalog from pi.dev (Earendil Inc.) is retrieved for the list of available AI models.</p>
<p>These requests come from the server. Providers see only the homelab's IP address and the requested address (titles/IDs), no data of visitors and no cookies. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is researching dubbed versions and providing model selection.</p>`,
    },
  },
  {
    id: "email",
    de: {
      heading: "Kontakt per E-Mail",
      body: `<p>Wenn Sie per E-Mail Kontakt aufnehmen, werden Ihre E-Mail-Adresse, der Inhalt Ihrer Nachricht und die technischen Angaben der E-Mail verarbeitet, um Ihre Anfrage zu beantworten. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt darin, Anfragen beantworten zu können.</p>
<p>Die E-Mail-Postfächer werden bei der Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australien, als Auftragsverarbeiter betrieben. Dabei können Daten in Länder außerhalb der EU übermittelt werden, insbesondere nach Australien, in die USA und nach Indien. Für diese Übermittlungen verwendet Fastmail Standardvertragsklauseln der EU-Kommission (Art. 46 Abs. 2 lit. c DSGVO). Details: <a href="https://www.fastmail.com/policies/privacy/">Datenschutzerklärung von Fastmail</a>, <a href="https://www.fastmail.com/policies/dpa/">Auftragsverarbeitungsvertrag</a> und <a href="https://www.fastmail.com/policies/dpa/section3/">Standardvertragsklauseln</a>. Eine Kopie der Garantien erhalten Sie auf Anfrage an <a href="mailto:datenschutz-beasty-arr@heerlab.com">datenschutz-beasty-arr@heerlab.com</a>.</p>
<p>Der Verantwortliche löscht Nachrichten nach Erledigung der Anfrage, soweit keine Aufbewahrung erforderlich ist. Bei Fastmail können anschließend noch Sicherungs- und Protokolldaten nach dessen veröffentlichten Löschregeln verbleiben.</p>`,
    },
    en: {
      heading: "Contact by e-mail",
      body: `<p>If you contact us by e-mail, your e-mail address, the content of your message and the technical details of the e-mail are processed to answer your request. The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is being able to answer requests.</p>
<p>The mailboxes are hosted by Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australia, as a processor. Data may be transferred to countries outside the EU, in particular Australia, the USA and India. For these transfers, Fastmail uses the European Commission's Standard Contractual Clauses (Art. 46(2)(c) GDPR). Details: <a href="https://www.fastmail.com/policies/privacy/">Fastmail privacy policy</a>, <a href="https://www.fastmail.com/policies/dpa/">data processing agreement</a> and <a href="https://www.fastmail.com/policies/dpa/section3/">Standard Contractual Clauses</a>. You can obtain a copy of the safeguards by writing to <a href="mailto:datenschutz-beasty-arr@heerlab.com">datenschutz-beasty-arr@heerlab.com</a>.</p>
<p>The controller deletes messages after dealing with the request unless retention remains necessary. Fastmail may subsequently retain backup and log data under its published deletion rules.</p>`,
    },
  },
  {
    id: "cookies",
    de: {
      heading: "Cookies und lokale Speicherung",
      body: `<table><thead><tr><th scope="col">Eintrag</th><th scope="col">Anbieter</th><th scope="col">Zweck</th><th scope="col">Dauer</th><th scope="col">Erforderlichkeit</th></tr></thead><tbody><tr><td>Pangolin-Sitzungs-Cookie: ${PANGOLIN_COOKIE}</td><td>Pangolin, nach der Anmeldung</td><td>Authentifizierung</td><td>${PANGOLIN_COOKIE_DURATION}</td><td>Technisch notwendig, § 25 Abs. 2 Nr. 2 TDDDG</td></tr><tr><td>localStorage: ba.sidebar</td><td>beasty-arr</td><td>Merkt sich, ob die Seitenleiste eingeklappt ist</td><td>Bis zum Löschen</td><td>Technisch notwendig, § 25 Abs. 2 Nr. 2 TDDDG, vom Nutzer angefordert</td></tr></tbody></table>
<p>Die rechtlichen Seiten selbst setzen keine Cookies und speichern nichts im Browser.</p>`,
    },
    en: {
      heading: "Cookies and local storage",
      body: `<table><thead><tr><th scope="col">Entry</th><th scope="col">Provider</th><th scope="col">Purpose</th><th scope="col">Duration</th><th scope="col">Necessity</th></tr></thead><tbody><tr><td>Pangolin session cookie: ${PANGOLIN_COOKIE}</td><td>Pangolin, after sign-in</td><td>Authentication</td><td>${PANGOLIN_COOKIE_DURATION}</td><td>Technically necessary, Section 25(2) no. 2 TDDDG</td></tr><tr><td>localStorage: ba.sidebar</td><td>beasty-arr</td><td>Remembers whether the sidebar is collapsed</td><td>Until cleared</td><td>Technically necessary, Section 25(2) no. 2 TDDDG, requested by the user</td></tr></tbody></table>
<p>The legal pages themselves set no cookies and store nothing in the browser.</p>`,
    },
  },
  {
    id: "rights",
    de: {
      heading: "Ihre Rechte",
      body: `<p>Sie haben gegenüber dem Verantwortlichen folgende Rechte hinsichtlich Ihrer personenbezogenen Daten:</p>
<ul><li>Auskunft (Art. 15 DSGVO)</li><li>Berichtigung (Art. 16 DSGVO)</li><li>Löschung (Art. 17 DSGVO)</li><li>Einschränkung der Verarbeitung (Art. 18 DSGVO)</li><li>Datenübertragbarkeit (Art. 20 DSGVO)</li><li>Widerruf einer erteilten Einwilligung (Art. 7 Abs. 3 DSGVO): Sie können eine erteilte Einwilligung jederzeit widerrufen. Die Rechtmäßigkeit der Verarbeitung vor dem Widerruf bleibt unberührt.</li></ul>
<p><strong>Widerspruchsrecht (Art. 21 DSGVO):</strong> Soweit eine Verarbeitung auf Art. 6 Abs. 1 lit. f DSGVO beruht, können Sie aus Gründen, die sich aus Ihrer besonderen Situation ergeben, jederzeit widersprechen.</p>
<p>Zur Ausübung Ihrer Rechte genügt eine Nachricht an <a href="mailto:datenschutz-beasty-arr@heerlab.com">datenschutz-beasty-arr@heerlab.com</a>.</p>
<p>Sie haben außerdem das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren, insbesondere in dem Mitgliedstaat Ihres gewöhnlichen Aufenthalts, Ihres Arbeitsplatzes oder des Orts des mutmaßlichen Verstoßes (Art. 77 DSGVO).</p>`,
    },
    en: {
      heading: "Your rights",
      body: `<p>You have the following rights regarding your personal data:</p>
<ul><li>access (Art. 15 GDPR)</li><li>rectification (Art. 16 GDPR)</li><li>erasure (Art. 17 GDPR)</li><li>restriction of processing (Art. 18 GDPR)</li><li>data portability (Art. 20 GDPR)</li><li>withdrawal of consent (Art. 7(3) GDPR): you may withdraw consent at any time. Withdrawal does not affect the lawfulness of processing before withdrawal.</li></ul>
<p><strong>Right to object (Art. 21 GDPR):</strong> Where processing is based on Art. 6(1)(f) GDPR, you may object at any time on grounds relating to your particular situation.</p>
<p>To exercise your rights, simply send a message to <a href="mailto:datenschutz-beasty-arr@heerlab.com">datenschutz-beasty-arr@heerlab.com</a>.</p>
<p>You also have the right to lodge a complaint with a data protection supervisory authority, in particular in the member state of your habitual residence, place of work or place of the alleged infringement (Art. 77 GDPR).</p>`,
    },
  },
  {
    id: "provision",
    de: {
      heading: "Pflicht zur Bereitstellung",
      body: `<p>Sie sind nicht verpflichtet, personenbezogene Daten bereitzustellen. Ohne die technisch notwendigen Verbindungsdaten kann die Website jedoch nicht ausgeliefert werden, und ohne Anmeldung sind die geschützten Bereiche nicht nutzbar.</p>`,
    },
    en: {
      heading: "Obligation to provide data",
      body: `<p>You are not obliged to provide personal data. However, the website cannot be delivered without the technically necessary connection data, and the protected areas cannot be used without signing in.</p>`,
    },
  },
  {
    id: "changes",
    de: {
      heading: "Änderungen",
      body: `<p>Diese Datenschutzerklärung wird angepasst, wenn sich die Website oder die Rechtslage ändert. Es gilt die jeweils hier veröffentlichte Fassung.</p>`,
    },
    en: {
      heading: "Changes",
      body: `<p>This privacy policy is updated when the website or the legal situation changes. The version published here applies.</p>`,
    },
  },
];
