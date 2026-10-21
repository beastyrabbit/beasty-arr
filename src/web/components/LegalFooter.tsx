export function LegalFooter() {
  return (
    <footer className="shrink-0 border-t border-line px-4 py-3 text-[12px] text-muted sm:px-5">
      <nav aria-label="Legal information" className="flex flex-wrap gap-x-5 gap-y-2">
        <a className="hover:text-ink" href="/legal-notice">
          Legal notice
        </a>
        <a className="hover:text-ink" href="/privacy">
          Privacy
        </a>
        <a className="hover:text-ink" href="/impressum" lang="de">
          Impressum
        </a>
        <a className="hover:text-ink" href="/datenschutz" lang="de">
          Datenschutz
        </a>
      </nav>
    </footer>
  );
}
