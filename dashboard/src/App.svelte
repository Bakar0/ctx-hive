<script lang="ts">
  import Sidebar from "./components/Sidebar.svelte";
  import Pipeline from "./pages/Pipeline.svelte";
  import Memories from "./pages/Memories.svelte";
  import Repos from "./pages/Repos.svelte";
  import Search from "./pages/Search.svelte";
  import { DashboardSocket } from "./state/socket.svelte.ts";
  import { repoStore } from "./state/repos.svelte.ts";
  import * as api from "./api/client";

  let page = $state(localStorage.getItem("ctx-hive-page") ?? "pipeline");
  const socket = new DashboardSocket();
  let projects = $state<string[]>([]);

  let pipelineRef = $state<Pipeline>();
  let memoriesRef = $state<Memories>();
  let searchRef = $state<Search>();

  $effect(() => {
    socket.connect();
    fetchProjects();

    // Wire WebSocket events to page refreshes
    socket.on("job:started", () => { if (page === "pipeline") pipelineRef?.fetchPipelines(); });
    socket.on("job:completed", () => { if (page === "pipeline") pipelineRef?.fetchPipelines(); });
    socket.on("job:failed", () => { if (page === "pipeline") pipelineRef?.fetchPipelines(); });
    socket.on("pipeline:started", () => { if (page === "pipeline") pipelineRef?.fetchPipelines(); });
    socket.on("pipeline:stage-changed", () => { if (page === "pipeline") pipelineRef?.fetchPipelines(); });
    socket.on("pipeline:completed", () => { if (page === "pipeline") pipelineRef?.fetchPipelines(); });
    socket.on("pipeline:failed", () => { if (page === "pipeline") pipelineRef?.fetchPipelines(); });
    socket.on("memory:created", () => { if (page === "memories") memoriesRef?.fetchMemories(); });
    socket.on("memory:deleted", () => { if (page === "memories") memoriesRef?.fetchMemories(); });
    socket.on("repo:tracked", () => { repoStore.refresh(); });
    socket.on("repo:untracked", () => { repoStore.refresh(); });
    socket.on("repo:scan-complete", () => { repoStore.refresh(); });
    socket.on("search:executed", () => { if (page === "search") searchRef?.fetchData(); });

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
</script>

<div class="flex h-screen">
  <Sidebar currentPage={page} connected={socket.connected} onNavigate={navigate} />

  <main class="flex-1 overflow-y-auto p-6 px-8">
    {#if page === "pipeline"}
      <Pipeline bind:this={pipelineRef} {projects} />
    {:else if page === "memories"}
      <Memories bind:this={memoriesRef} {projects} />
    {:else if page === "repos"}
      <Repos />
    {:else if page === "search"}
      <Search bind:this={searchRef} />
    {/if}
  </main>
</div>
