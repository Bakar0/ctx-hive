<script lang="ts">
  import Sidebar from "./components/Sidebar.svelte";
  import Overview from "./pages/Overview.svelte";
  import Jobs from "./pages/Jobs.svelte";
  import Contexts from "./pages/Contexts.svelte";
  import Repos from "./pages/Repos.svelte";
  import Search from "./pages/Search.svelte";
  import { DashboardSocket } from "./state/socket.svelte.ts";
  import * as api from "./api/client";

  let page = $state(localStorage.getItem("ctx-hive-page") ?? "overview");
  const socket = new DashboardSocket();
  let projects = $state<string[]>([]);

  // Page component refs for re-fetching on WS events
  let jobsRef = $state<Jobs>();
  let contextsRef = $state<Contexts>();
  let reposRef = $state<Repos>();

  $effect(() => {
    socket.connect();
    fetchProjects();

    // Wire WebSocket events to page refreshes
    socket.on("job:started", () => { if (page === "jobs") jobsRef?.fetchJobs(); });
    socket.on("job:completed", () => { if (page === "jobs") jobsRef?.fetchJobs(); });
    socket.on("job:failed", () => { if (page === "jobs") jobsRef?.fetchJobs(); });
    socket.on("job:queued", () => { if (page === "jobs") jobsRef?.fetchJobs(); });
    socket.on("context:created", () => { if (page === "contexts") contextsRef?.fetchContexts(); });
    socket.on("context:deleted", () => { if (page === "contexts") contextsRef?.fetchContexts(); });
    socket.on("repo:tracked", () => { if (page === "repos") reposRef?.fetchRepos(); });
    socket.on("repo:untracked", () => { if (page === "repos") reposRef?.fetchRepos(); });
    socket.on("repo:scan-complete", () => { if (page === "repos") reposRef?.fetchRepos(); });

    return () => socket.disconnect();
  });

  async function fetchProjects() {
    try {
      projects = await api.getProjects();
    } catch {
      // silent
    }
  }

  function navigate(p: string) {
    page = p;
    localStorage.setItem("ctx-hive-page", p);
  }

  function registerMetricsHandler(handler: (data: unknown) => void) {
    socket.on("metrics", handler);
  }

</script>

<div class="flex h-screen">
  <Sidebar currentPage={page} connected={socket.connected} onNavigate={navigate} />

  <main class="flex-1 overflow-y-auto p-6 px-8">
    {#if page === "overview"}
      <Overview onWsMetrics={registerMetricsHandler} />
    {:else if page === "jobs"}
      <Jobs bind:this={jobsRef} {projects} />
    {:else if page === "contexts"}
      <Contexts bind:this={contextsRef} {projects} />
    {:else if page === "repos"}
      <Repos bind:this={reposRef} />
    {:else if page === "search"}
      <Search />
    {/if}
  </main>
</div>
