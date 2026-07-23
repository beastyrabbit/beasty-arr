import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Crosshair,
  LayoutDashboard,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { sse, useSseStatus } from "../lib/events.js";
import { useConfig } from "../lib/queries.js";
import { cn } from "../lib/utils.js";
import { CommandPalette } from "./CommandPalette.js";
import { LedDot, type LedState } from "./LedDot.js";
import { TooltipProvider } from "./ui/tooltip.js";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/library/series", label: "Library", icon: Library, match: "/library" },
  { to: "/hunt", label: "Hunt", icon: Crosshair, match: "/hunt" },
  { to: "/fixer", label: "Fixer", icon: Wrench, match: "/fixer" },
  { to: "/activity/searches", label: "Activity", icon: Activity, match: "/activity" },
  { to: "/settings/connections", label: "Settings", icon: Settings, match: "/settings" },
] as const;

function sseToLed(status: ReturnType<typeof useSseStatus>): LedState {
  switch (status) {
    case "live":
      return "live";
    case "reconnecting":
    case "connecting":
      return "reconnecting";
    case "down":
      return "down";
    default:
      return "off";
  }
}

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ba.sidebar") === "1");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sseStatus = useSseStatus();
  const navigate = useNavigate();
  const { data: config } = useConfig();
  const dryRun = config?.settings.dryRun ?? false;

  useEffect(() => {
    sse.connect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleSidebar = () => {
    setCollapsed((c) => {
      localStorage.setItem("ba.sidebar", c ? "0" : "1");
      return !c;
    });
  };

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col">
        {/* top bar */}
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
          <button
            type="button"
            onClick={toggleSidebar}
            className="cursor-pointer text-muted hover:text-ink"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
          <Link to="/" className="text-[13px] font-semibold tracking-tight text-ink">
            beasty<span className="text-accent">-arr</span>
          </Link>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="ml-4 flex h-7 w-[220px] cursor-pointer items-center gap-2 rounded-[6px] border border-line bg-bg px-2 text-[12px] text-faint hover:border-accent/40"
          >
            <Search size={12} />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="microlabel rounded border border-line px-1 py-px">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-3">
            {dryRun ? (
              <Link
                to="/settings/danger"
                className="flex h-5 items-center gap-1.5 rounded-full border border-accent/60 px-2 text-[10px] font-semibold tracking-[0.08em] text-accent uppercase"
              >
                Dry run
              </Link>
            ) : null}
            <span className="flex items-center gap-1.5" title={`events: ${sseStatus}`}>
              <LedDot state={sseToLed(sseStatus)} />
              <span className="microlabel hidden sm:inline">events</span>
            </span>
          </div>
        </header>

        {/* dry-run banner strip on EVERY page */}
        {dryRun ? (
          <button
            type="button"
            onClick={() => navigate({ to: "/settings/danger" })}
            className="dry-run-stripes flex h-6 w-full shrink-0 cursor-pointer items-center justify-center border-b border-accent/40 text-[11px] font-medium text-accent"
          >
            DRY RUN — nothing is sent to Sonarr/Radarr/Prowlarr. Click to change.
          </button>
        ) : null}

        <div className="flex min-h-0 flex-1">
          {/* sidebar */}
          <nav
            className={cn(
              "flex shrink-0 flex-col gap-0.5 border-r border-line bg-surface py-2",
              collapsed ? "w-11 items-center px-1" : "w-44 px-2",
            )}
          >
            {NAV.map(({ to, label, icon: Icon, ...item }) => (
              <Link
                key={to}
                to={to}
                activeOptions={{ exact: "exact" in item && item.exact === true }}
                activeProps={{ "data-active": "true" }}
                className={cn(
                  "flex h-8 items-center gap-2.5 rounded-[6px] px-2 text-[12px] font-medium text-muted hover:bg-raised hover:text-ink",
                  "data-[active=true]:bg-raised data-[active=true]:text-accent",
                  collapsed && "w-8 justify-center px-0",
                )}
                title={label}
              >
                <Icon size={15} className="shrink-0" />
                {!collapsed && label}
              </Link>
            ))}
          </nav>

          <main className="min-w-0 flex-1 overflow-x-hidden p-4">
            <Outlet />
          </main>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </TooltipProvider>
  );
}
