import { AboutPage } from './pages/AboutPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { RemoteAccessPage } from './pages/RemoteAccessPage';
import { installPlaybackFullscreen } from "./lib/playback-fullscreen";
import { installRemoteNavigation } from "./lib/remote";
import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider, useNavigate, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./components/AppShell";
import { GenrePage, HomePage } from "./pages/HomePage";
import { PlayRedirect, TitlePage } from "./pages/TitlePage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { HistoryPage, MePage, MyListPage, SearchPage } from "./pages/ListPages";
import { LibraryPage, SettingsPage } from "./pages/AdminPages";
import { SourcesPage, SourceBrowsePage } from "./pages/SourcesPage";
import { WatchPage } from "./pages/WatchPage";
import { AccountsPage } from "./pages/AccountsPage";
import { useMe } from "./api/queries";
import { EmptyState } from "./components/ui";
import { ApiError, currentProfileId } from "./lib/api";
import type { MediaType } from "@moa/shared";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/pages.css";
import "./styles/player.css";

if (import.meta.env.VITE_MOCK === "1") {
  const { installMockApi } = await import("./api/mock");
  installMockApi();
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 10 * 60_000, retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500), refetchOnWindowFocus: false }
  }
});
if (import.meta.env.VITE_MOA_LITE === '1') window.addEventListener('moa-lite:changed', () => { void queryClient.invalidateQueries(); });

/** Every app route needs a chosen profile; the server also enforces it. */
function RequireProfile({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  useEffect(() => {
    const onRequired = () => navigate("/profiles", { replace: true });
    window.addEventListener("moa:profile-required", onRequired);
    return () => window.removeEventListener("moa:profile-required", onRequired);
  }, [navigate]);
  return currentProfileId() ? <>{children}</> : <Navigate to="/profiles" replace />;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return null;
  return me.data?.role === "admin" ? <>{children}</> : <div className="page-pad narrow"><EmptyState title="관리자만 볼 수 있어요" body="소스와 라이브러리는 관리자가 관리해요." /></div>;
}

function GenreRoute({ type }: { type?: MediaType }) {
  const { genre = "" } = useParams();
  return <GenrePage type={type} genre={decodeURIComponent(genre)} />;
}

const router = createBrowserRouter([
  { path: "/profiles", element: <ProfilesPage /> },
  { path: "/watch/:episodeId", element: <RequireProfile><WatchPage /></RequireProfile> },
  { path: "/play/:id", element: <RequireProfile><PlayRedirect /></RequireProfile> },
  {
    element: <RequireProfile><AppShell /></RequireProfile>,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/series", element: <Navigate to="/tabs/series" replace /> },
      { path: "/movies", element: <Navigate to="/tabs/movies" replace /> },
      { path: "/anime", element: <Navigate to="/tabs/anime" replace /> },
      { path: "/tabs/:tabId", element: <HomePage /> },
      { path: "/local", element: import.meta.env.VITE_MOA_LITE === '1' ? <Navigate to="/" replace /> : <HomePage localOnly /> },
      { path: "/local/genre/:genre", element: import.meta.env.VITE_MOA_LITE === '1' ? <Navigate to="/" replace /> : <GenreRoute /> },
      { path: "/series/genre/:genre", element: <GenreRoute type="series" /> },
      { path: "/movies/genre/:genre", element: <GenreRoute type="movie" /> },
      { path: "/anime/genre/:genre", element: <GenreRoute type="anime" /> },
      { path: "/title/:id", element: <TitlePage /> },
      { path: "/search", element: <SearchPage /> },
      { path: "/my-list", element: <MyListPage /> },
      { path: "/history", element: <HistoryPage /> },
      { path: "/sources", element: <RequireAdmin><SourcesPage /></RequireAdmin> },
      { path: "/sources/:id", element: <SourceBrowsePage /> },
      { path: "/library", element: import.meta.env.VITE_MOA_LITE === '1' ? <Navigate to="/" replace /> : <RequireAdmin><LibraryPage /></RequireAdmin> },
      { path: "/remote-access", element: import.meta.env.VITE_MOA_LITE === '1' ? <Navigate to="/" replace /> : <RequireAdmin><RemoteAccessPage /></RequireAdmin> },
      { path: "/accounts", element: <AccountsPage /> },
      { path: "/about", element: <AboutPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/settings/tabs", element: <SettingsPage /> },
      { path: "/settings/diagnostics", element: import.meta.env.VITE_MOA_LITE === '1' ? <RequireAdmin><DiagnosticsPage /></RequireAdmin> : <Navigate to="/settings" replace /> },
      { path: "/me", element: <MePage /> },
      { path: "*", element: <Navigate to="/" replace /> }
    ]
  }
]);
if (import.meta.env.VITE_MOA_LITE === '1') {
  const { cancelPendingReads } = await import('../../lite/client/index');
  let locationKey = router.state.location.key;
  router.subscribe(state => { if (state.location.key !== locationKey) { locationKey = state.location.key; cancelPendingReads(); } });
}

const disposeRemote = installRemoteNavigation(router);
const disposeFullscreen = installPlaybackFullscreen(router);
if (import.meta.hot) import.meta.hot.dispose(() => { disposeRemote(); disposeFullscreen(); });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
