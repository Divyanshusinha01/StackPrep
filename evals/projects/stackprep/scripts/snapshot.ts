/**
 * Rebuilds corpora/stackprep/bundle.json from git objects at corpus.json's commit_sha, never from the
 * working tree. Passing a commit writes it to corpus.json first. Re-pin "stackprep-snapshot" afterwards.
 *
 *   deno run --allow-run=git --allow-read=evals --allow-write=evals --config supabase/functions/deno.json \
 *     evals/projects/stackprep/scripts/snapshot.ts [commit]
 */
import { stableJson } from "../../../core/keys.ts";
import { BUNDLE_FORMAT, type CorpusBundle, type CorpusManifest } from "../src/corpus-source.ts";

const corpusDir = new URL("../corpora/stackprep/", import.meta.url);

async function git(args: string[]): Promise<Uint8Array> {
  const { success, stdout, stderr } = await new Deno.Command("git", { args, cwd: corpusDir, stdout: "piped", stderr: "piped" }).output();
  if (!success) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr).trim()}`);
  }
  return stdout;
}

const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

async function main(requested: string | undefined): Promise<void> {
  const manifestUrl = new URL("corpus.json", corpusDir);
  const manifest = JSON.parse(await Deno.readTextFile(manifestUrl)) as CorpusManifest;
  if (manifest.source.type !== "bundle" || !manifest.include?.length) {
    throw new Error("corpus.json must describe a bundle source with include paths");
  }
  const commit = text(await git(["rev-parse", "--verify", `${requested ?? manifest.commit_sha}^{commit}`])).trim();
  if (commit !== manifest.commit_sha) {
    await Deno.writeTextFile(manifestUrl, stableJson({ ...manifest, commit_sha: commit }));
  }

  const root = text(await git(["rev-parse", "--show-toplevel"])).trim();
  const match = new RegExp(manifest.match ?? ".");
  const exclude = (manifest.exclude ?? []).map((pattern) => new RegExp(pattern));
  const listed = text(await git(["-C", root, "ls-tree", "-r", "--name-only", commit, "--", ...manifest.include]))
    .split("\n")
    .filter((path) => path && match.test(path) && !exclude.some((re) => re.test(path)) && !path.startsWith("evals/"))
    .sort();

  const files: Record<string, string> = {};
  for (const path of listed) {
    files[path] = text(await git(["-C", root, "show", `${commit}:${path}`]));
  }
  const bundle: CorpusBundle = { format: BUNDLE_FORMAT, commit_sha: commit, files };
  await Deno.writeTextFile(new URL(manifest.source.path, corpusDir), stableJson(bundle));
  const bytes = Object.values(files).reduce((n, content) => n + content.length, 0);
  console.log(`Wrote ${listed.length} files (${bytes} chars) at ${commit.slice(0, 12)}. Re-pin with: eval pin --pins stackprep-snapshot --reason "..."`);
}

if (import.meta.main) {
  await main(Deno.args[0]);
}
