<script lang="ts">
  import StatCard from "../components/StatCard.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as api from "../api/client";
  import type { VectorSearchSettings, BackfillStatus } from "../api/types";

  // ── State ──────────────────────────────────────────────────
  let vecSettings = $state<VectorSearchSettings | null>(null);
  let backfillStatus = $state<BackfillStatus | null>(null);
  let apiKeyInput = $state("");
  let savingSettings = $state(false);
  let settingsError = $state("");
  let settingsSuccess = $state("");
  let backfillPolling = $state<ReturnType<typeof setInterval> | null>(null);

  let vectorCoverage = $derived(vecSettings != null && vecSettings.totalCount > 0 ? Math.round((vecSettings.embeddedCount / vecSettings.totalCount) * 100) : 0);

  // ── Data fetching ──────────────────────────────────────────
  $effect(() => {
    fetchSettings();
    return () => {
      if (backfillPolling !== null) clearInterval(backfillPolling);
    };
  });

  async function fetchSettings() {
    try {
      vecSettings = await api.getVectorSearchSettings();
      backfillStatus = await api.getBackfillStatus();
    } catch { /* silent */ }
  }

  // ── Actions ────────────────────────────────────────────────
  async function saveSettings() {
    savingSettings = true;
    settingsError = "";
    settingsSuccess = "";
    try {
      const update: { enabled?: boolean; apiKey?: string } = {};
      if (apiKeyInput !== "") update.apiKey = apiKeyInput;
      update.enabled = true;
      const res = await api.updateVectorSearchSettings(update);
      if ("error" in res && res.error) {
        settingsError = res.error;
      } else {
        settingsSuccess = "Settings saved";
        apiKeyInput = "";
        await fetchSettings();
        if (res.backfillStarted) startBackfillPolling();
      }
    } catch (err) {
      settingsError = String(err);
    }
    savingSettings = false;
  }

  async function disableVector() {
    savingSettings = true;
    settingsError = "";
    settingsSuccess = "";
    try {
      await api.updateVectorSearchSettings({ enabled: false });
      settingsSuccess = "Vector search disabled";
      await fetchSettings();
    } catch (err) {
      settingsError = String(err);
    }
    savingSettings = false;
  }

  async function triggerBackfill() {
    try {
      await api.triggerBackfill();
      startBackfillPolling();
    } catch { /* silent */ }
  }

  function startBackfillPolling() {
    if (backfillPolling !== null) return;
    backfillPolling = setInterval(async () => {
      try {
        backfillStatus = await api.getBackfillStatus();
        if (backfillStatus !== null && !backfillStatus.inProgress) {
          clearInterval(backfillPolling!);
          backfillPolling = null;
          await fetchSettings();
        }
      } catch { /* silent */ }
    }, 2000);
  }

  export function fetchData() { fetchSettings(); }
</script>

<div class="flex items-center justify-between mb-6">
  <div>
    <h1 class="text-xl font-semibold mb-1">Settings</h1>
    <p class="text-sm text-muted-foreground">Configure ctx-hive</p>
  </div>
</div>

<div class="space-y-6">
  <!-- Stats overview -->
  <div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
    {#if vecSettings}
      <StatCard label="Vector Coverage" value="{vectorCoverage}%" color={vectorCoverage >= 80 ? "green" : vectorCoverage >= 50 ? "yellow" : "red"} sub="{vecSettings.embeddedCount}/{vecSettings.totalCount} entries" />
    {/if}
  </div>

  <!-- Vector Search Config -->
  <Card.Root>
    <div class="p-4 border-b border-border">
      <h3 class="text-sm font-semibold">Vector Search</h3>
      <p class="text-xs text-muted-foreground mt-1">Use OpenRouter.ai embeddings for semantic search alongside FTS5</p>
    </div>
    <div class="p-4 space-y-4">
      {#if vecSettings}
        <!-- Status indicator -->
        <div class="flex items-center gap-2">
          <div class="size-2.5 rounded-full {vecSettings.enabled ? 'bg-success' : 'bg-muted-foreground/30'}"></div>
          <span class="text-sm font-medium">{vecSettings.enabled ? "Enabled" : "Disabled"}</span>
          {#if vecSettings.enabled}
            <span class="text-xs text-muted-foreground">using {vecSettings.model}</span>
          {/if}
        </div>

        <!-- sqlite-vec status -->
        {#if !vecSettings.sqliteVecAvailable}
          <div class="flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs">
            <svg class="size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            sqlite-vec extension not loaded. Vector search requires Homebrew SQLite with extension support.
          </div>
        {/if}

        <!-- API Key -->
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground" for="api-key">OpenRouter API Key</label>
          <div class="flex gap-2">
            <Input
              id="api-key"
              type="password"
              placeholder={vecSettings.hasApiKey ? "Key configured — enter new to replace" : "sk-or-v1-..."}
              bind:value={apiKeyInput}
              class="flex-1 font-mono text-xs"
            />
          </div>
          {#if vecSettings.hasApiKey}
            <p class="text-[10px] text-success font-mono">Key configured</p>
          {/if}
        </div>

        <!-- Actions -->
        <div class="flex gap-2">
          {#if !vecSettings.enabled || apiKeyInput !== ""}
            <Button size="sm" onclick={saveSettings} disabled={savingSettings}>
              {savingSettings ? "Saving..." : vecSettings.enabled ? "Update Key" : "Enable & Save"}
            </Button>
          {/if}
          {#if vecSettings.enabled}
            <Button variant="outline" size="sm" onclick={disableVector} disabled={savingSettings}>
              Disable
            </Button>
          {/if}
        </div>

        {#if settingsError}
          <p class="text-xs text-destructive">{settingsError}</p>
        {/if}
        {#if settingsSuccess}
          <p class="text-xs text-success">{settingsSuccess}</p>
        {/if}

        <!-- Embedding progress -->
        {#if vecSettings.enabled}
          <div class="border-t border-border pt-4 space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium text-muted-foreground">Embeddings</span>
              <span class="font-mono text-xs text-muted-foreground">{vecSettings.embeddedCount} / {vecSettings.totalCount}</span>
            </div>
            <div class="w-full h-2 bg-muted/30 rounded-full overflow-hidden">
              <div
                class="h-full bg-purple rounded-full transition-all duration-300"
                style="width: {vecSettings.totalCount > 0 ? (vecSettings.embeddedCount / vecSettings.totalCount) * 100 : 0}%"
              ></div>
            </div>
            {#if backfillStatus?.inProgress}
              <p class="text-[10px] font-mono text-muted-foreground">
                Backfilling... {backfillStatus.done}/{backfillStatus.total}
                {#if backfillStatus.failed > 0}
                  ({backfillStatus.failed} failed)
                {/if}
              </p>
            {:else if vecSettings.embeddedCount < vecSettings.totalCount}
              <Button variant="outline" size="sm" onclick={triggerBackfill}>
                Backfill {vecSettings.totalCount - vecSettings.embeddedCount} Missing
              </Button>
            {/if}
          </div>
        {/if}
      {:else}
        <div class="text-sm text-muted-foreground">Loading settings...</div>
      {/if}
    </div>
  </Card.Root>
</div>
