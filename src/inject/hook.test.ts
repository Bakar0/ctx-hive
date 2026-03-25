import { describe, test, expect } from "bun:test";
import { shouldSearch } from "./hook.ts";
import { tokenize } from "../ctx/search.ts";

function check(prompt: string): boolean {
  return shouldSearch(prompt, tokenize(prompt));
}

describe("shouldSearch", () => {
  test("skips slash commands", () => {
    expect(check("/commit")).toBe(false);
    expect(check("/review-pr 123")).toBe(false);
    expect(check("/help")).toBe(false);
  });

  test("skips shell passthrough", () => {
    expect(check("! git status")).toBe(false);
    expect(check("! bun test")).toBe(false);
  });

  test("skips confirmations and short answers", () => {
    expect(check("yes")).toBe(false);
    expect(check("no")).toBe(false);
    expect(check("ok")).toBe(false);
    expect(check("do it")).toBe(false);
    expect(check("go ahead")).toBe(false);
    expect(check("sure")).toBe(false);
    expect(check("lgtm")).toBe(false);
    expect(check("ship it")).toBe(false);
    expect(check("thanks")).toBe(false);
  });

  test("skips imperative action commands", () => {
    expect(check("run the tests")).toBe(false);
    expect(check("build the project")).toBe(false);
    expect(check("test src/foo.ts")).toBe(false);
    expect(check("lint the code")).toBe(false);
    expect(check("fix it")).toBe(false);
    expect(check("refactor this")).toBe(false);
    expect(check("delete the file")).toBe(false);
  });

  test("skips git commands", () => {
    expect(check("commit the changes")).toBe(false);
    expect(check("push to origin main")).toBe(false);
    expect(check("merge the branch")).toBe(false);
  });

  test("skips prompts that look like pure code", () => {
    expect(check("const x = { a: 1 }")).toBe(false);
    expect(check("fn(a, b) => c")).toBe(false);
  });

  test("skips very short prompts without signals", () => {
    expect(check("add button")).toBe(false);
    expect(check("fix bug")).toBe(false);
  });

  test("searches for questions", () => {
    expect(check("how does the pipeline system work?")).toBe(true);
    expect(check("why did we choose SQLite over Postgres?")).toBe(true);
    expect(check("what is the entry schema?")).toBe(true);
    expect(check("where are the pipeline definitions?")).toBe(true);
  });

  test("searches for architecture/design queries", () => {
    expect(check("explain the architecture of the daemon")).toBe(true);
    expect(check("what design patterns does this use")).toBe(true);
    expect(check("are there any gotchas with the search system")).toBe(true);
    expect(check("what are the constraints for entry creation")).toBe(true);
  });

  test("searches for medium-length descriptive prompts", () => {
    expect(check("the search results are not relevant to my queries")).toBe(true);
    expect(check("I need to understand the injection pipeline flow")).toBe(true);
    expect(check("entries are being duplicated across sessions and projects")).toBe(true);
  });

  test("searches for prompts mentioning context/history", () => {
    expect(check("what is the context behind this decision")).toBe(true);
    expect(check("tell me the rationale for using FTS5")).toBe(true);
    expect(check("what trade-offs were considered here")).toBe(true);
  });
});
