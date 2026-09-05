import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from "@tanstack/react-router";
import { AppLayout } from "./components/Layout.js";
import { EmptyState } from "./components/Shell.js";
import { validateLibrarySearch } from "./lib/library-search.js";

const ActivityPage = lazyRouteComponent(() => import("./pages/Activity.js"), "ActivityPage");
const DashboardPage = lazyRouteComponent(() => import("./pages/Dashboard.js"), "DashboardPage");
const FixerPage = lazyRouteComponent(() => import("./pages/Fixer.js"), "FixerPage");
const FixerHistoryPage = lazyRouteComponent(
  () => import("./pages/FixerHistory.js"),
  "FixerHistoryPage",
);
const HuntPage = lazyRouteComponent(() => import("./pages/Hunt.js"), "HuntPage");
const LibraryPage = lazyRouteComponent(() => import("./pages/Library.js"), "LibraryPage");
const MissingPage = lazyRouteComponent(() => import("./pages/Missing.js"), "MissingPage");
const MovieDetailPage = lazyRouteComponent(
  () => import("./pages/MovieDetail.js"),
  "MovieDetailPage",
);
const SeriesDetailPage = lazyRouteComponent(
  () => import("./pages/SeriesDetail.js"),
  "SeriesDetailPage",
);
const SettingsPage = lazyRouteComponent(() => import("./pages/Settings.js"), "SettingsPage");

const rootRoute = createRootRoute({ component: Outlet });

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: DashboardPage,
});

const librarySeriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/library/series",
  validateSearch: validateLibrarySearch,
  component: () => <LibraryPage kind="series" />,
});

const libraryMoviesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/library/movies",
  validateSearch: validateLibrarySearch,
  component: () => <LibraryPage kind="movies" />,
});

const seriesDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/library/series/$seriesId",
  validateSearch: (search: Record<string, unknown>): { season?: number; live?: boolean } => {
    const season =
      typeof search.season === "number"
        ? search.season
        : typeof search.season === "string" && search.season !== ""
          ? Number(search.season)
          : undefined;
    return {
      ...(Number.isFinite(season) ? { season } : {}),
      ...(search.live === true || search.live === "true" ? { live: true } : {}),
    };
  },
  component: SeriesDetailPage,
});

const movieDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/library/movies/$movieId",
  validateSearch: (search: Record<string, unknown>): { live?: boolean } =>
    search.live === true || search.live === "true" ? { live: true } : {},
  component: MovieDetailPage,
});

const huntRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/hunt",
  component: HuntPage,
});

const missingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/missing",
  component: MissingPage,
});

const fixerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/fixer",
  component: FixerPage,
});

const fixerHistoryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/fixer/history",
  component: FixerHistoryPage,
});

const activitySearchesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/activity/searches",
  component: () => <ActivityPage tab="searches" />,
});
const activityAiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/activity/ai",
  component: () => <ActivityPage tab="ai" />,
});
const activityBudgetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/activity/budget",
  component: () => <ActivityPage tab="budget" />,
});

const settingsConnectionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/connections",
  component: () => <SettingsPage tab="connections" />,
});
const settingsHuntRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/hunt",
  component: () => <SettingsPage tab="hunt" />,
});
const settingsAiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/ai",
  component: () => <SettingsPage tab="ai" />,
});
const settingsDangerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/danger",
  component: () => <SettingsPage tab="danger" />,
});

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([
    dashboardRoute,
    librarySeriesRoute,
    libraryMoviesRoute,
    seriesDetailRoute,
    movieDetailRoute,
    huntRoute,
    missingRoute,
    fixerRoute,
    fixerHistoryRoute,
    activitySearchesRoute,
    activityAiRoute,
    activityBudgetRoute,
    settingsConnectionsRoute,
    settingsHuntRoute,
    settingsAiRoute,
    settingsDangerRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: () => (
    <EmptyState message="Nothing here." hint="Check the URL or head back to the dashboard." />
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
