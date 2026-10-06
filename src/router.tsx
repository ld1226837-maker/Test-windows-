import { keepPreviousData, QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  // Local-first data (IndexedDB): mutations invalidate what changed, so tabs
  // should reuse cached rows instead of re-reading the database on every mount.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 30 * 60_000,
        // true = refetch on mount only when stale. Seeded/cached first-paint
        // data is marked stale (initialDataUpdatedAt: 0), so it is always
        // verified against IndexedDB once; later mounts reuse the fresh cache.
        refetchOnMount: true,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: 0,
        // Keep the previous year-window rows visible while the new IndexedDB
        // query is running; this removes blank/loading churn on tab switches.
        placeholderData: keepPreviousData,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
