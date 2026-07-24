import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AppLayout } from "./components/Layout.js";
import { EmptyState } from "./components/Shell.js";
import { validateLibrarySearch } from "./lib/library-search.js";
import { ActivityPage } from "./pages/Activity.js";
import { DashboardPage } from "./pages/Dashboard.js";
import { FixerPage } from "./pages/Fixer.js";
import { FixerHistoryPage } from "./pages/FixerHistory.js";
import { HuntPage } from "./pages/Hunt.js";
import { LibraryPage } from "./pages/Library.js";
import { MovieDetailPage } from "./pages/MovieDetail.js";
import { SeriesDetailPage } from "./pages/SeriesDetail.js";
import { SettingsPage } from "./pages/Settings.js";

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
  component: SeriesDetailPage,
});

const movieDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/library/movies/$movieId",
  component: MovieDetailPage,
});

const huntRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/hunt",
  component: HuntPage,
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
