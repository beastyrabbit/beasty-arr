// Verified rollout templates, with site-specific processing blocks kept bilingual.
export type LegalLanguage = "de" | "en";
type SectionText = { heading: string; body: string };
type BilingualText = { de: SectionText; en: SectionText };
type BilingualSection = BilingualText & { id: string };

const LEGAL_EMAILS = {
  notice: "impressum-beasty-arr@heerlab.com",
  privacy: "datenschutz-beasty-arr@heerlab.com",
};
const CONTACT_FORM =
  '<a href="https://beastyrabbit.com/kontakt?from=beasty-arr">beastyrabbit.com/kontakt</a>';

function mailLink(address: string): string {
  return `<a href="mailto:${address}">${address}</a>`;
}

function operatorAddress(country: string): string {
  return `<p>Tobias Heer<br>
c/o Impressumservice Dein-Impressum<br>
Stettiner Str. 41<br>
35410 Hungen<br>
${country}</p>`;
}

// Object insertion order determines the order of the returned section blocks.
function orderedSections(content: Record<string, BilingualText>): readonly BilingualSection[] {
  return Object.entries(content).map(([id, text]) => ({ id, ...text }));
}

export const legalNoticeSections: readonly BilingualSection[] = orderedSections({
  provider: {
    de: {
      heading: "Anbieter",
      body: operatorAddress("Deutschland"),
    },
    en: {
      heading: "Provider",
      body: operatorAddress("Germany"),
    },
  },
  contact: {
    de: {
      heading: "Kontakt",
      body: `<p>E-Mail: ${mailLink(LEGAL_EMAILS.notice)}<br>
Kontaktformular: ${CONTACT_FORM}</p>`,
    },
    en: {
      heading: "Contact",
      body: `<p>E-mail: ${mailLink(LEGAL_EMAILS.notice)}<br>
Contact form: ${CONTACT_FORM}</p>`,
    },
  },
  note: {
    de: {
      heading: "Hinweis",
      body: `<p>beasty-arr ist ein privates, nicht-kommerzielles Projekt.</p>`,
    },
    en: {
      heading: "Note",
      body: `<p>beasty-arr is a private, non-commercial project.</p>`,
    },
  },
  privacy: {
    de: {
      heading: "Datenschutz",
      body: `<p>Informationen zur Verarbeitung personenbezogener Daten finden Sie in der <a href="/datenschutz">Datenschutzerklärung</a>.</p>`,
    },
    en: {
      heading: "Privacy",
      body: `<p>For information on how personal data is processed, see the <a href="/privacy">Privacy Policy</a>.</p>`,
    },
  },
});

export const privacySections: readonly BilingualSection[] = orderedSections({
  controller: {
    de: {
      heading: "Verantwortlicher",
      body: `<p>Verantwortlich für die Verarbeitung personenbezogener Daten auf https://beasty-arr.heerlab.com ist:</p>
${operatorAddress("Deutschland")}
<p>E-Mail: ${mailLink(LEGAL_EMAILS.privacy)}</p>
<p>Ein Datenschutzbeauftragter ist nicht bestellt, da hierzu keine gesetzliche Pflicht besteht.</p>`,
    },
    en: {
      heading: "Controller",
      body: `<p>The controller responsible for processing personal data on https://beasty-arr.heerlab.com is:</p>
${operatorAddress("Germany")}
<p>E-mail: ${mailLink(LEGAL_EMAILS.privacy)}</p>
<p>No data protection officer has been appointed, as there is no legal obligation to do so.</p>`,
    },
  },
  overview: {
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
  hosting: {
    de: {
      heading: "Hosting und Bereitstellung",
      body: `<p>beasty-arr läuft auf eigener Server-Infrastruktur des Verantwortlichen in Deutschland. Aufrufe aus dem Internet erreichen die Anwendung über einen Reverse-Proxy auf einem virtuellen Server der netcup GmbH, Emmy-Noether-Straße 10, 76131 Karlsruhe, Deutschland (Rechenzentrum in Nürnberg). netcup verarbeitet die Daten dabei als Auftragsverarbeiter; mit netcup besteht ein Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO. Die Verbindung ist bis zum Reverse-Proxy TLS-verschlüsselt und wird von dort durch einen verschlüsselten Tunnel an die eigene Infrastruktur weitergeleitet.</p>
<p>Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in einer sicheren und zuverlässigen Bereitstellung der Website.</p>
<p>Zur Datensicherung werden regelmäßig Sicherungskopien innerhalb der eigenen Infrastruktur erstellt; sie werden nach Ablauf ihrer Aufbewahrungszeit überschrieben.</p>`,
    },
    en: {
      heading: "Hosting and delivery",
      body: `<p>beasty-arr runs on the controller's own server infrastructure in Germany. Requests from the internet reach the application through a reverse proxy on a virtual server operated by netcup GmbH, Emmy-Noether-Straße 10, 76131 Karlsruhe, Germany (data center in Nuremberg). netcup processes the data as a processor under a data processing agreement pursuant to Art. 28 GDPR. The connection is TLS-encrypted up to the reverse proxy and forwarded from there to the controller's infrastructure through an encrypted tunnel.</p>
<p>The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the secure and reliable provision of the website.</p>
<p>For data protection, backup copies are created regularly within the controller's own infrastructure; they are overwritten once their retention time has elapsed.</p>`,
    },
  },
  logs: {
    de: {
      heading: "Server-Logfiles",
      body: `<p>Bei jedem Aufruf speichert der Reverse-Proxy automatisch folgende Daten:</p>
<ul><li>IP-Adresse des anfragenden Geräts</li><li>Datum und Uhrzeit des Zugriffs</li><li>aufgerufene Adresse (Pfad einschließlich Parameter), HTTP-Methode und Protokoll</li><li>HTTP-Statuscode, übertragene Datenmenge und Antwortzeit</li><li>Browser-Kennung (User-Agent)</li><li>verwendete TLS-Version und Verschlüsselung</li><li>angesprochener Dienst</li></ul>
<p>Die Header Cookie und Authorization werden geschwärzt. URL-Pfade und Abfrageparameter werden protokolliert.</p>
<p>Die Daten dienen dem Betrieb, der Fehleranalyse und der Abwehr von Angriffen und Missbrauch. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in Stabilität und Sicherheit des Angebots. Die Logfiles werden nach 14 Tagen automatisch gelöscht.</p>
<p>Pangolin speichert Anfrage- und Netzwerkprotokolle für bis zu 30 Tage und Anmeldeprotokolle für 90 Tage. Die Anwendung schreibt ein kurzlebiges Betriebsprotokoll mit IP-Adresse, Zeitpunkt, angefragter Adresse und Status für Betrieb und Fehleranalyse. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO.</p>`,
    },
    en: {
      heading: "Server log files",
      body: `<p>For every request, the reverse proxy automatically stores the following data:</p>
<ul><li>IP address of the requesting device</li><li>date and time of access</li><li>requested address (path including parameters), HTTP method and protocol</li><li>HTTP status code, amount of data transferred, and response time</li><li>browser identifier (user agent)</li><li>TLS version and cipher used</li><li>target service</li></ul>
<p>The Cookie and Authorization headers are redacted. URL paths and query parameters are logged.</p>
<p>This data is used to operate the site, analyse errors, and defend against attacks and abuse. The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the stability and security of the service. Log files are deleted automatically after 14 days.</p>
<p>Pangolin keeps request and network logs for up to 30 days and sign-in logs for 90 days. The application writes a short-lived operational log containing IP address, time, requested address and status for operation and troubleshooting. The legal basis is Art. 6(1)(f) GDPR.</p>`,
    },
  },
  crowdsec: {
    de: {
      heading: "Schutz vor Angriffen (CrowdSec)",
      body: `<p>Zum Schutz vor Angriffen wertet die Sicherheitssoftware CrowdSec die Server-Logfiles automatisch aus und sperrt IP-Adressen, von denen erkennbar Angriffe ausgehen (zum Beispiel massenhafte Anmeldeversuche oder das Ausspähen von Schwachstellen). Erkennt CrowdSec einen Angriff, werden die IP-Adresse, der Zeitpunkt und die Art des Angriffs an die CrowdSec SAS, 20 rue Maurice Arnoux, 92120 Montrouge, Frankreich, übermittelt. CrowdSec nutzt diese Meldungen für eine gemeinsame Sperrliste, die Angriffe auf viele Server abwehrt. Bei normalem Surfen werden keine Daten an CrowdSec übermittelt.</p>
<p>Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt im Schutz der Website und ihrer Nutzer vor Angriffen.</p>
<p>Für diese Verarbeitung sind der Verantwortliche und CrowdSec nach Angaben von CrowdSec gemeinsam verantwortlich (Art. 26 DSGVO): CrowdSec ist für den Betrieb seiner zentralen Dienste und Sperrlisten verantwortlich, der Verantwortliche für den Einsatz auf diesem Server. Sie können Ihre Rechte gegenüber beiden geltend machen, bei CrowdSec unter ${mailLink("dpo@crowdsec.net")}. CrowdSec kann die gemeldeten Daten an Mitglieder und Partner seines Netzwerks weitergeben. Übermittlungen in Länder außerhalb der EU erfolgen nach Angaben von CrowdSec auf Grundlage von Standardvertragsklauseln der EU-Kommission (Art. 46 Abs. 2 lit. c DSGVO).</p>
<p>Vollständige IP-Adressen werden grundsätzlich höchstens drei Monate gespeichert und anschließend schrittweise verallgemeinert. Für bestimmte Angriffsanalysen und Trainingszwecke nennt CrowdSec Ausnahmen von bis zu einem Jahr vor der Anonymisierung. Details: <a href="https://www.crowdsec.net/privacy-policy">crowdsec.net/privacy-policy</a>.</p>`,
    },
    en: {
      heading: "Protection against attacks (CrowdSec)",
      body: `<p>To protect against attacks, the security software CrowdSec automatically analyses the server log files and blocks IP addresses that are clearly the source of attacks (for example mass login attempts or scanning for vulnerabilities). When CrowdSec detects an attack, the IP address, time and type of attack are sent to CrowdSec SAS, 20 rue Maurice Arnoux, 92120 Montrouge, France. CrowdSec uses these reports for a shared blocklist that protects many servers. No data is sent to CrowdSec during normal browsing.</p>
<p>The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is protecting the website and its users from attacks.</p>
<p>According to CrowdSec, the controller and CrowdSec are jointly responsible for this processing (Art. 26 GDPR): CrowdSec is responsible for operating its central services and blocklists, the controller for its use on this server. You can exercise your rights against either of them; CrowdSec can be reached at ${mailLink("dpo@crowdsec.net")}. CrowdSec may pass the reported data on to members and partners of its network. According to CrowdSec, transfers to countries outside the EU are based on the European Commission's Standard Contractual Clauses (Art. 46(2)(c) GDPR).</p>
<p>Full IP addresses are generally retained for no more than three months and then progressively generalised. CrowdSec describes exceptions of up to one year before anonymisation for certain attack analyses and training purposes. Details: <a href="https://www.crowdsec.net/privacy-policy">crowdsec.net/privacy-policy</a>.</p>`,
    },
  },
  sso: {
    de: {
      heading: "Anmeldung (Single Sign-On)",
      body: `<p>beasty-arr ist nur für eingeladene Personen zugänglich. Die Anmeldung erfolgt über den Reverse-Proxy Pangolin mit dem selbst betriebenen Identitätsdienst Pocket-ID auf der eigenen Infrastruktur. Dabei werden Benutzername, E-Mail-Adresse, Gruppenzugehörigkeit, Zeitpunkt der Anmeldung und IP-Adresse verarbeitet. Nach der Anmeldung setzt Pangolin ein Sitzungs-Cookie, das für den Zugang technisch erforderlich ist.</p>
<p>In der Praxis ist der Zugang durch Rollen auf den Verantwortlichen selbst beschränkt. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt darin, den Zugang auf berechtigte Personen zu beschränken.</p>
<p>Das Benutzerkonto in Pocket-ID und Pangolin besteht, solange der Zugang eingeräumt ist, und wird auf Anfrage oder nach Entzug des Zugangs gelöscht. Anmeldeprotokolle werden nach 90 Tagen gelöscht.</p>`,
    },
    en: {
      heading: "Sign-in (single sign-on)",
      body: `<p>beasty-arr is only accessible to invited people. Sign-in is handled by the Pangolin reverse proxy with Pocket-ID, an identity service self-hosted on the controller's infrastructure. This processes your user name, e-mail address, group membership, time of sign-in and IP address. After sign-in, Pangolin sets a session cookie that is technically required for access.</p>
<p>In practice, role restrictions limit access to the controller himself. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is restricting access to authorised persons.</p>
<p>The user account in Pocket-ID and Pangolin exists for as long as access is granted and is deleted on request or after access is withdrawn. Authentication logs are deleted after 90 days.</p>`,
    },
  },
  "app-data": {
    de: {
      heading: "In der Anwendung gespeicherte Daten",
      body: `<p>beasty-arr hat keine eigenen Nutzerkonten. Auf der eigenen Infrastruktur werden Bibliotheksdaten aus den eigenen Sonarr-/Radarr-Diensten des Verantwortlichen, Such- und Aktivitätsverläufe, Ergebnisse von KI-Analysen und eigene Notizen gespeichert. Dies betrifft nur die eigene Nutzung des Verantwortlichen zur Verwaltung seiner Mediathek. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO.</p>
<p>Diese Daten werden bis zu 10 Jahre gespeichert.</p>`,
    },
    en: {
      heading: "Data stored in the application",
      body: `<p>beasty-arr has no user accounts of its own. The controller's own infrastructure stores library data from his own Sonarr/Radarr services, search and activity history, AI analysis results and his own notes. This concerns only the controller's own use to manage his media library. The legal basis is Art. 6(1)(f) GDPR.</p>
<p>This data is stored for up to 10 years.</p>`,
    },
  },
  posters: {
    de: {
      heading: "Vorschaubilder (TheTVDB und TMDB)",
      body: `<p>Nach der Anmeldung lädt der Browser Vorschaubilder direkt von den Bilddiensten von TheTVDB und TMDB. Diese erhalten die IP-Adresse und die angefragte Bildadresse. Die Anbieter können Daten außerhalb der EU verarbeiten, unter anderem in den USA. Die Anzeige der Vorschaubilder erfolgt auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO. Weitere Informationen: <a href="https://www.thetvdb.com/privacy-policy">Datenschutzerklärung von TheTVDB</a> und <a href="https://www.themoviedb.org/privacy-policy">Datenschutzerklärung von TMDB</a>.</p>`,
    },
    en: {
      heading: "Poster images",
      body: `<p>After sign-in, the browser loads poster images directly from the image services of TheTVDB and TMDB. These receive the IP address and the requested image address. The providers may process data outside the EU, including in the USA. The display of poster images is based on Art. 6(1)(f) GDPR. Further information: <a href="https://www.thetvdb.com/privacy-policy">TheTVDB privacy policy</a> and <a href="https://www.themoviedb.org/privacy-policy">TMDB privacy policy</a>.</p>`,
    },
  },
  openai: {
    de: {
      heading: "KI-Analyse (OpenAI)",
      body: `<p>Zur Prüfung deutscher Synchronfassungen und zur Reparatur blockierter Importe sendet der Server Titel und Medienmetadaten an OpenAI über das eigene ChatGPT-Konto des Verantwortlichen. Bei Importreparaturen gehören dazu auch Datei- und Release-Namen, Pfade und optionale Untertitelauszüge. Daten von Besuchern werden nicht übermittelt. Dabei können Daten in die USA übermittelt werden. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Weitere Informationen: <a href="https://openai.com/policies/">OpenAI-Richtlinien</a>.</p>`,
    },
    en: {
      heading: "AI analysis (OpenAI)",
      body: `<p>For German-dub checks and stuck-import repair, the server sends titles and media metadata to OpenAI through the controller's own ChatGPT account. Import repair also includes file and release names, paths and optional subtitle excerpts. No data of visitors is sent. Data may be transferred to the USA in the process. The legal basis is Art. 6(1)(f) GDPR. Further information: <a href="https://openai.com/policies/">OpenAI policies</a>.</p>`,
    },
  },
  "external-information": {
    de: {
      heading: "Abruf externer Informationen",
      body: `<p>Der Server und die selbst betriebenen Dienste Sonarr/Radarr/Prowlarr fragen die konfigurierten Indexer mit den eigenen Konten des Verantwortlichen sowie öffentliche Informationsquellen ab. Dazu gehören etwa Wikidata, Wikipedia, Synchronkartei, fernsehserien.de, JustWatch, öffentliche Titelseiten von Streamingdiensten, weitere von der KI-Analyse gefundene öffentliche Seiten und der Modellkatalog von pi.dev. Die Anbieter erhalten dabei die IP-Adresse des Homelabs und die angefragten Titel/IDs, Indexer zusätzlich die Zugangsdaten der Konten des Verantwortlichen; Daten von Besuchern werden nicht übermittelt. Die Abrufe dienen der Suche nach passenden Veröffentlichungen, der Recherche zu Synchronfassungen und der Modellauswahl. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO.</p>`,
    },
    en: {
      heading: "Retrieval of external information",
      body: `<p>The server and the self-hosted Sonarr/Radarr/Prowlarr services query the configured indexers using the controller's own accounts, as well as public information sources. These include, for example, Wikidata, Wikipedia, Synchronkartei, fernsehserien.de, JustWatch, streaming services' public title pages, other public pages found by the AI analysis and the pi.dev model catalog. The providers receive the homelab's IP address and the requested titles/IDs; indexers also receive the credentials for the controller's accounts. No data of visitors is transmitted. These requests serve release searches, research into dubbed versions and model selection. The legal basis is Art. 6(1)(f) GDPR.</p>`,
    },
  },
  email: {
    de: {
      heading: "Kontakt per E-Mail",
      body: `<p>Wenn Sie per E-Mail Kontakt aufnehmen, werden Ihre E-Mail-Adresse, der Inhalt Ihrer Nachricht und die technischen Angaben der E-Mail verarbeitet, um Ihre Anfrage zu beantworten. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt darin, Anfragen beantworten zu können.</p>
<p>Die E-Mail-Postfächer werden bei der Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australien, als Auftragsverarbeiter betrieben. Dabei können Daten in Länder außerhalb der EU übermittelt werden, insbesondere nach Australien, in die USA und nach Indien. Für diese Übermittlungen verwendet Fastmail Standardvertragsklauseln der EU-Kommission (Art. 46 Abs. 2 lit. c DSGVO). Details: <a href="https://www.fastmail.com/policies/privacy/">Datenschutzerklärung von Fastmail</a>, <a href="https://www.fastmail.com/policies/dpa/">Auftragsverarbeitungsvertrag</a> und <a href="https://www.fastmail.com/policies/dpa/section3/">Standardvertragsklauseln</a>. Eine Kopie der Garantien erhalten Sie auf Anfrage an ${mailLink(LEGAL_EMAILS.privacy)}.</p>
<p>Der Verantwortliche löscht Nachrichten nach Erledigung der Anfrage, soweit keine Aufbewahrung erforderlich ist. Bei Fastmail können anschließend noch Sicherungs- und Protokolldaten nach dessen veröffentlichten Löschregeln verbleiben.</p>`,
    },
    en: {
      heading: "Contact by e-mail",
      body: `<p>If you contact us by e-mail, your e-mail address, the content of your message and the technical details of the e-mail are processed to answer your request. The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is being able to answer requests.</p>
<p>The mailboxes are hosted by Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australia, as a processor. Data may be transferred to countries outside the EU, in particular Australia, the USA and India. For these transfers, Fastmail uses the European Commission's Standard Contractual Clauses (Art. 46(2)(c) GDPR). Details: <a href="https://www.fastmail.com/policies/privacy/">Fastmail privacy policy</a>, <a href="https://www.fastmail.com/policies/dpa/">data processing agreement</a> and <a href="https://www.fastmail.com/policies/dpa/section3/">Standard Contractual Clauses</a>. You can obtain a copy of the safeguards by writing to ${mailLink(LEGAL_EMAILS.privacy)}.</p>
<p>The controller deletes messages after dealing with the request unless retention remains necessary. Fastmail may subsequently retain backup and log data under its published deletion rules.</p>`,
    },
  },
  cookies: {
    de: {
      heading: "Cookies und lokale Speicherung",
      body: `<p>Nach der Anmeldung setzt Pangolin ein technisch notwendiges Sitzungs-Cookie, das für die Dauer der Anmeldesitzung gültig ist (§ 25 Abs. 2 Nr. 2 TDDDG). Die Anwendung speichert außerdem die vom Nutzer gewünschte Einstellung der Seitenleiste in localStorage (ba.sidebar), bis diese gelöscht wird. Auch diese Speicherung ist technisch notwendig (§ 25 Abs. 2 Nr. 2 TDDDG). Die rechtlichen Seiten selbst setzen keine Cookies und speichern nichts im Browser.</p>`,
    },
    en: {
      heading: "Cookies and local storage",
      body: `<p>After sign-in, Pangolin sets a technically necessary session cookie, valid for the duration of the sign-in session (Section 25(2) no. 2 TDDDG). The application also stores the user's preferred sidebar setting in localStorage (ba.sidebar) until cleared. This storage is also technically necessary (Section 25(2) no. 2 TDDDG). The legal pages themselves set no cookies and store nothing in the browser.</p>`,
    },
  },
  rights: {
    de: {
      heading: "Ihre Rechte",
      body: `<p>Sie haben gegenüber dem Verantwortlichen folgende Rechte hinsichtlich Ihrer personenbezogenen Daten:</p>
<ul><li>Auskunft (Art. 15 DSGVO)</li><li>Berichtigung (Art. 16 DSGVO)</li><li>Löschung (Art. 17 DSGVO)</li><li>Einschränkung der Verarbeitung (Art. 18 DSGVO)</li><li>Datenübertragbarkeit (Art. 20 DSGVO)</li><li>Widerruf einer erteilten Einwilligung (Art. 7 Abs. 3 DSGVO): Sie können eine erteilte Einwilligung jederzeit widerrufen. Die Rechtmäßigkeit der Verarbeitung vor dem Widerruf bleibt unberührt.</li></ul>
<p><strong>Widerspruchsrecht (Art. 21 DSGVO):</strong> Soweit eine Verarbeitung auf Art. 6 Abs. 1 lit. f DSGVO beruht, können Sie aus Gründen, die sich aus Ihrer besonderen Situation ergeben, jederzeit widersprechen.</p>
<p>Zur Ausübung Ihrer Rechte genügt eine Nachricht an ${mailLink(LEGAL_EMAILS.privacy)}.</p>
<p>Sie haben außerdem das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren, insbesondere in dem Mitgliedstaat Ihres gewöhnlichen Aufenthalts, Ihres Arbeitsplatzes oder des Orts des mutmaßlichen Verstoßes (Art. 77 DSGVO).</p>`,
    },
    en: {
      heading: "Your rights",
      body: `<p>You have the following rights regarding your personal data:</p>
<ul><li>access (Art. 15 GDPR)</li><li>rectification (Art. 16 GDPR)</li><li>erasure (Art. 17 GDPR)</li><li>restriction of processing (Art. 18 GDPR)</li><li>data portability (Art. 20 GDPR)</li><li>withdrawal of consent (Art. 7(3) GDPR): you may withdraw consent at any time. Withdrawal does not affect the lawfulness of processing before withdrawal.</li></ul>
<p><strong>Right to object (Art. 21 GDPR):</strong> Where processing is based on Art. 6(1)(f) GDPR, you may object at any time on grounds relating to your particular situation.</p>
<p>To exercise your rights, simply send a message to ${mailLink(LEGAL_EMAILS.privacy)}.</p>
<p>You also have the right to lodge a complaint with a data protection supervisory authority, in particular in the member state of your habitual residence, place of work or place of the alleged infringement (Art. 77 GDPR).</p>`,
    },
  },
  provision: {
    de: {
      heading: "Pflicht zur Bereitstellung",
      body: `<p>Sie sind nicht verpflichtet, personenbezogene Daten bereitzustellen. Ohne die technisch notwendigen Verbindungsdaten kann die Website jedoch nicht ausgeliefert werden, und ohne Anmeldung sind die geschützten Bereiche nicht nutzbar.</p>`,
    },
    en: {
      heading: "Obligation to provide data",
      body: `<p>You are not obliged to provide personal data. However, the website cannot be delivered without the technically necessary connection data, and the protected areas cannot be used without signing in.</p>`,
    },
  },
  changes: {
    de: {
      heading: "Änderungen",
      body: `<p>Diese Datenschutzerklärung wird angepasst, wenn sich die Website oder die Rechtslage ändert. Es gilt die jeweils hier veröffentlichte Fassung.</p>`,
    },
    en: {
      heading: "Changes",
      body: `<p>This privacy policy is updated when the website or the legal situation changes. The version published here applies.</p>`,
    },
  },
});
