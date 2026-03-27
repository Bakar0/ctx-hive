import * as api from "../api/client.ts";
import type { DiscoveredRepo } from "../api/types.ts";

class RepoStore {
  repos = $state<DiscoveredRepo[] | null>(null);
  fetching = $state(false);
  syncingRepos = $state(new Set<string>());
  filter = $state("");

  get initialLoading(): boolean {
    return this.repos === null && this.fetching;
  }

  get refreshing(): boolean {
    return this.repos !== null && this.fetching;
  }

  async refresh(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const [tracked, scanned] = await Promise.all([api.getRepos(), api.scanRepos()]);
      const trackedMap = new Map(tracked.map((r) => [r.absPath, r]));
      const merged = scanned.map((r) => trackedMap.get(r.absPath) ?? r);
      for (const t of tracked) {
        if (!scanned.find((s) => s.absPath === t.absPath)) merged.push(t);
      }
      merged.sort((a, b) => {
        if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
        return (b.lastModifiedAt ?? "").localeCompare(a.lastModifiedAt ?? "");
      });
      this.repos = merged;
    } catch {
      /* silent */
    } finally {
      this.fetching = false;
    }
  }

  async track(absPath: string): Promise<void> {
    try {
      await api.trackRepo(absPath);
      await this.refresh();
    } catch {
      /* silent */
    }
  }

  async untrack(absPath: string): Promise<void> {
    try {
      await api.untrackRepo(absPath);
      await this.refresh();
    } catch {
      /* silent */
    }
  }

  async sync(absPath: string): Promise<void> {
    this.syncingRepos = new Set([...this.syncingRepos, absPath]);
    try {
      await api.syncRepo(absPath);
    } catch {
      /* silent */
    }
    this.syncingRepos = new Set([...this.syncingRepos].filter((p) => p !== absPath));
  }

  async openIn(absPath: string, target: "vscode" | "terminal"): Promise<void> {
    try {
      await api.openRepo(absPath, target);
    } catch {
      /* silent */
    }
  }
}

export const repoStore = new RepoStore();
