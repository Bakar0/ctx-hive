<script lang="ts">
  import Badge from "./Badge.svelte";
  import Sparkline from "../charts/Sparkline.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { timeAgo } from "../format/time";
  import { formatCompact } from "../format/numbers";
  import { renderMarkdown } from "../format/markdown";
  import * as api from "../api/client";
  import type { ContextEntry, EntrySignals } from "../api/types";
  import { computeUsageScore, computeRelevanceScore, RATING_LEGEND } from "$lib/scoring";

  interface Props {
    contextId: string | null;
    onClose: () => void;
    onDelete?: (id: string) => void;
  }

  let { contextId, onClose, onDelete }: Props = $props();

  let context = $state<ContextEntry | null>(null);
  let signals = $state<EntrySignals | null>(null);
  let viewMode = $state<"preview" | "raw">("preview");
  let renderedHtml = $derived(context ? renderMarkdown(context.body) : "");

  $effect(() => {
    if (contextId == null) {
      context = null;
      signals = null;
      return;
    }
    viewMode = "preview";
    const id = contextId;
    void (async () => {
      try {
        const [ctxAll, sigStore] = await Promise.all([api.getContexts(), api.getSignals()]);
        context = ctxAll.find((c) => c.id === id) ?? null;
        signals = sigStore.entries?.[id] ?? null;
      } catch { /* silent */ }
    })();
  });

  function scoreBarColor(s: number): string {
    return s < 0.3 ? "var(--destructive)" : s < 0.6 ? "var(--warning)" : "var(--success)";
  }

  let usageScore = $derived(signals ? computeUsageScore(signals.searchHits ?? [], new Date()) : 0);
  let relevanceScore = $derived(signals ? computeRelevanceScore(signals.evaluations ?? [], new Date()) : 0.5);

  let evalCounts = $derived.by(() => {
    const evals = signals?.evaluations ?? [];
    const c: Record<string, number> = { "-1": 0, "0": 0, "1": 0, "2": 0 };
    for (const ev of evals) c[String(ev.rating)] = (c[String(ev.rating)] ?? 0) + 1;
    return Object.entries(c).filter(([, v]) => v > 0);
  });

  const RATING_COLORS: Record<string, string> = Object.fromEntries(RATING_LEGEND.map(r => [String(r.rating), r.color]));
  const RATING_LABELS: Record<string, string> = Object.fromEntries(RATING_LEGEND.map(r => [String(r.rating), r.label]));

  async function handleDelete(id: string) {
    if (!confirm("Delete this context entry? This cannot be undone.")) return;
    try {
      await api.deleteContext(id);
      onClose();
      onDelete?.(id);
    } catch { /* silent */ }
  }
</script>

<Dialog.Root open={contextId != null} onOpenChange={(open) => { if (!open) onClose(); }}>
  <Dialog.Content class="max-w-3xl sm:max-w-3xl max-h-[85vh] flex flex-col overflow-hidden p-0 gap-0">
    {#if context}
      <Dialog.Header class="sticky top-0 z-10 bg-card border-b p-4 pb-3 shrink-0">
        <Dialog.Title>{context.title}</Dialog.Title>
      </Dialog.Header>
      <div class="flex-1 overflow-y-auto px-4 py-4">
      <div class="flex gap-3 flex-wrap mb-4">
        <Badge variant={context.scope} />
        <span class="font-mono text-xs">{context.project || "\u2014"}</span>
        <span class="font-mono text-xs text-muted-foreground">{context.id}</span>
        {#if context.tokens > 0}<span class="font-mono text-xs text-muted-foreground">{formatCompact(context.tokens)} tokens</span>{/if}
      </div>

      <div class="flex gap-4 mb-4 flex-wrap">
          <div class="flex flex-col items-center px-3 py-2 bg-background border rounded-md min-w-20">
            <span class="text-lg font-bold font-mono" style="color:{scoreBarColor(signals?.score ?? 0)}">{(signals?.score ?? 0).toFixed(2)}</span>
            <span class="text-[10px] text-dim uppercase tracking-wider mt-0.5">Score</span>
          </div>
          <div class="flex flex-col items-center px-3 py-2 bg-background border rounded-md min-w-20">
            <span class="text-lg font-bold font-mono">{(signals?.searchHits ?? []).reduce((s, b) => s + b.count, 0)}</span>
            <span class="text-[10px] text-dim uppercase tracking-wider mt-0.5">Total Hits</span>
          </div>
          <div class="flex flex-col items-center px-3 py-2 bg-background border rounded-md min-w-20">
            <span class="text-lg font-bold font-mono">{(signals?.searchHits ?? []).filter(b => new Date(b.date).getTime() >= Date.now() - 30 * 86400000).reduce((s, b) => s + b.count, 0)}</span>
            <span class="text-[10px] text-dim uppercase tracking-wider mt-0.5">30d Hits</span>
          </div>
          <div class="flex flex-col items-center px-3 py-2 bg-background border rounded-md min-w-20">
            <span class="text-lg font-bold font-mono">{(signals?.evaluations ?? []).length}</span>
            <span class="text-[10px] text-dim uppercase tracking-wider mt-0.5">Evals</span>
          </div>
          <div class="flex flex-col items-center px-3 py-2 bg-background border rounded-md min-w-20">
            <span class="text-lg font-bold font-mono">{Math.floor((Date.now() - new Date(context.updated).getTime()) / 86400000)}</span>
            <span class="text-[10px] text-dim uppercase tracking-wider mt-0.5">Days Old</span>
          </div>
        </div>
        {#if signals?.searchHits?.length}
          <div class="mt-1 mb-2">
            <span class="text-[10px] text-dim uppercase tracking-wider">Search activity (90d)</span>
            <Sparkline hits={signals.searchHits} days={90} wide />
          </div>
        {/if}

      <div class="flex justify-end mb-2">
        <div class="inline-flex rounded-lg border border-border overflow-hidden">
          <button
            class="px-2.5 py-1 text-xs font-medium transition-colors {viewMode === 'preview' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}"
            onclick={() => viewMode = "preview"}
          >Preview</button>
          <button
            class="px-2.5 py-1 text-xs font-medium transition-colors border-l border-border {viewMode === 'raw' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}"
            onclick={() => viewMode = "raw"}
          >Raw</button>
        </div>
      </div>
      <div class="grid [&>*]:col-start-1 [&>*]:row-start-1">
        <div class="{viewMode !== 'raw' ? 'invisible' : ''} text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap break-words bg-background rounded-md p-4 border">{context.body}</div>
        <div class="{viewMode !== 'preview' ? 'invisible' : ''} text-sm bg-background rounded-md p-4 border prose prose-invert prose-sm max-w-none">{@html renderedHtml}</div>
      </div>

      {#if signals}
        <div class="mt-4 p-4 bg-background border rounded-md">
          <h3 class="text-sm text-muted-foreground uppercase tracking-wider mb-3">Signals</h3>
          <div class="flex items-center gap-2.5 mb-3">
            <span class="text-lg font-bold min-w-11" style="color:{scoreBarColor(signals.score)}">{signals.score.toFixed(2)}</span>
            <div class="flex-1 h-2 bg-muted rounded overflow-hidden">
              <div class="h-full rounded transition-[width] duration-300" style="width:{signals.score * 100}%;background:{scoreBarColor(signals.score)}"></div>
            </div>
          </div>
          <div class="flex flex-col gap-1.5 mb-3">
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <span class="min-w-[120px]">Usage <span class="text-dim">(30%)</span></span>
              <span class="font-mono font-medium min-w-9" style="color:{scoreBarColor(usageScore)}">{usageScore.toFixed(2)}</span>
              <div class="flex-1 h-1.5 bg-muted rounded overflow-hidden">
                <div class="h-full rounded transition-[width] duration-300" style="width:{usageScore * 100}%;background:{scoreBarColor(usageScore)}"></div>
              </div>
            </div>
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <span class="min-w-[120px]">Relevance <span class="text-dim">(70%)</span></span>
              <span class="font-mono font-medium min-w-9" style="color:{scoreBarColor(relevanceScore)}">{relevanceScore.toFixed(2)}</span>
              <div class="flex-1 h-1.5 bg-muted rounded overflow-hidden">
                <div class="h-full rounded transition-[width] duration-300" style="width:{relevanceScore * 100}%;background:{scoreBarColor(relevanceScore)}"></div>
              </div>
            </div>
          </div>
          <div class="flex gap-4 mb-3 text-xs text-muted-foreground">
            <span>{(signals.searchHits ?? []).filter(b => new Date(b.date).getTime() >= Date.now() - 30 * 86400000).reduce((s, b) => s + b.count, 0)} hits (last 30d)</span>
            <span>{(signals.searchHits ?? []).reduce((s, b) => s + b.count, 0)} total hits</span>
            <span>{(signals.evaluations ?? []).length} evaluations</span>
          </div>
          {#if signals.evaluations?.length}
            <div class="flex gap-3 flex-wrap mb-2 text-xs text-muted-foreground">
              {#each evalCounts as [rating, count]}
                <span class="flex items-center gap-1">
                  <span class="size-2 rounded-full inline-block" style="background:{RATING_COLORS[rating]}"></span>
                  {count} {RATING_LABELS[rating]?.toLowerCase() ?? "?"}
                </span>
              {/each}
            </div>
            <div class="flex items-center gap-3 flex-wrap mb-2 text-[11px] text-dim">
              <span class="uppercase tracking-wider">Rating key</span>
              {#each RATING_LEGEND as r}
                <span class="flex items-center gap-1">
                  <span class="size-2 rounded-full inline-block" style="background:{r.color}"></span>
                  {r.label} = {r.normalized.toFixed(2)}
                </span>
              {/each}
            </div>
            <div class="flex flex-col gap-1.5">
              {#each [...signals.evaluations].reverse().slice(0, 10) as ev}
                <div class="flex items-start gap-2 text-xs p-1.5 px-2 bg-card rounded">
                  <span class="size-2.5 rounded-full shrink-0 mt-0.5" style="background:{RATING_COLORS[String(ev.rating)] ?? 'var(--dim)'};" title={RATING_LABELS[String(ev.rating)] ?? "?"}></span>
                  <span class="text-muted-foreground flex-1">{ev.reason || "no reason"}</span>
                  <span class="text-dim text-[11px] font-mono whitespace-nowrap">{ev.sessionId?.slice(0, 8) ?? "?"}</span>
                  <span class="text-dim text-[11px] whitespace-nowrap">{timeAgo(ev.evaluatedAt)}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      </div>
      <Dialog.Footer class="sticky bottom-0 shrink-0 mx-0 mb-0 rounded-b-xl border-t bg-card p-4 pt-3">
        <Button variant="outline" size="sm" onclick={() => navigator.clipboard.writeText(context!.id)}>Copy ID</Button>
        <Button variant="destructive" size="sm" onclick={() => handleDelete(context!.id)}>Delete</Button>
        <Dialog.Close>
          <Button variant="outline" size="sm">Close</Button>
        </Dialog.Close>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
