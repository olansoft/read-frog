#!/usr/bin/env bash
set -euo pipefail

branch=feature/notion-note-storage
upstream=mengxi-ream/read-frog
release=$(gh api "repos/$upstream/releases/latest")
release_id=$(jq -er '.id | numbers' <<< "$release")
release_tag=$(jq -er '.tag_name | strings' <<< "$release")
git check-ref-format "refs/tags/$release_tag"
marker="refs/tags/notion-upstream-release-$release_id"
if git ls-remote --exit-code origin "$marker" >/dev/null 2>&1; then
  echo 'updated=false' >> "$GITHUB_OUTPUT"
  echo "Latest stable upstream release is already built: $release_tag" >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

git fetch origin "refs/heads/$branch"
git checkout -B "$branch" FETCH_HEAD
git fetch "https://github.com/$upstream.git" "refs/tags/$release_tag"
release_sha=$(git rev-parse 'FETCH_HEAD^{commit}')
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
# Keep the fork's workflow definitions under its own control. GITHUB_TOKEN
# cannot push upstream edits to workflow files, and upstream release automation
# is not the fork's release policy. Other files merge normally.
if git merge-base --is-ancestor "$release_sha" HEAD; then
  echo 'The release is already contained in the Notion branch.'
else
  git merge --no-commit --no-ff "$release_sha" || true
  git rev-parse --verify MERGE_HEAD >/dev/null
  git restore --source=HEAD --staged --worktree -- .github/workflows
  if [[ -n "$(git diff --name-only --diff-filter=U)" ]]; then
    git merge --abort
    echo "::error::Cannot merge upstream $release_tag. Resolve the conflict on $branch; the branch has not been pushed."
    exit 1
  fi
  git commit -m "chore(sync): merge upstream $release_tag while retaining fork workflows"
fi
git push origin "HEAD:refs/heads/$branch"
{
  echo 'updated=true'
  echo "sha=$(git rev-parse HEAD)"
  echo "release_sha=$release_sha"
  echo "release_id=$release_id"
} >> "$GITHUB_OUTPUT"
printf 'Merged upstream stable release `%s` at `%s`.\n' "$release_tag" "$release_sha" >> "$GITHUB_STEP_SUMMARY"
