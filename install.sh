#!/usr/bin/env bash
# Links every mod and skill in skills/ into ~/.claude/skills, so a git pull updates them.
# A real folder of the same name already there is moved to
# ~/.claude/mods-backup-<date-time>/ first, outside the skills folder, so it does not load.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dest="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
backup="$HOME/.claude/mods-backup-$(date +%Y%m%d-%H%M%S)"

mkdir -p "$dest"
for src in "$here"/skills/*/; do
  src="${src%/}"
  name="$(basename "$src")"
  target="$dest/$name"
  if [ -L "$target" ]; then
    rm "$target"
  elif [ -e "$target" ]; then
    mkdir -p "$backup"
    mv "$target" "$backup/"
    echo "moved the old $name to $backup/"
  fi
  ln -s "$src" "$target"
  echo "linked $name"
done

echo "Done. Start a new Claude Code session to load them."
