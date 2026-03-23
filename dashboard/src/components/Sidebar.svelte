<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";

  interface Props {
    currentPage: string;
    connected: boolean;
    onNavigate: (page: string) => void;
  }

  let { currentPage, connected, onNavigate }: Props = $props();

  const pages = [
    { id: "overview", label: "Overview", icon: "overview" },
    { id: "jobs", label: "Jobs", icon: "jobs" },
    { id: "contexts", label: "Contexts", icon: "contexts" },
    { id: "repos", label: "Repos", icon: "repos" },
    { id: "search", label: "Search", icon: "search" },
    { id: "evaluations", label: "Evaluations", icon: "evaluations" },
  ] as const;
</script>

<aside class="w-[220px] shrink-0 flex flex-col bg-card border-r border-border">
  <div class="px-4 pt-5 pb-3 font-mono text-[15px] font-bold text-primary tracking-tight flex items-center gap-2">
    <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
      <line x1="12" y1="22.08" x2="12" y2="12"/>
    </svg>
    ctx-hive
  </div>

  <nav class="flex-1 p-2">
    {#each pages as p}
      <button
        class="flex items-center gap-2.5 w-full text-left px-3 py-2 rounded-md text-[13px] transition-all select-none
          {currentPage === p.id
            ? 'bg-muted text-foreground font-semibold'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
        onclick={() => onNavigate(p.id)}
      >
        <svg class="size-4 {currentPage === p.id ? 'opacity-100' : 'opacity-70'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          {#if p.icon === "overview"}
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          {:else if p.icon === "jobs"}
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          {:else if p.icon === "contexts"}
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
          {:else if p.icon === "repos"}
            <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/>
          {:else if p.icon === "search"}
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          {:else if p.icon === "evaluations"}
            <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
          {/if}
        </svg>
        {p.label}
      </button>
    {/each}
  </nav>

  <div class="px-4 py-3 border-t border-border text-[11px] text-dim font-mono">
    <span class="inline-block size-[7px] rounded-full mr-1.5 {connected ? 'bg-success' : 'bg-dim'}"></span>
    {connected ? "connected" : "disconnected"}
  </div>
</aside>
