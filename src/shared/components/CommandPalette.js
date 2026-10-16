"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import {
  NAV_ITEMS,
  SYSTEM_ITEMS,
  DEBUG_ITEMS,
  SETTINGS_ITEM,
  VISIBLE_MEDIA_KINDS,
  COMBINED_WEB_ITEM,
} from "@/shared/constants/navigation";
import { useTheme } from "@/shared/hooks/useTheme";
import useCommandPaletteStore from "@/store/commandPaletteStore";

const GROUP_ORDER = ["Navigation", "System", "Actions"];

function scoreCommand(command, query) {
  const q = query.trim().toLowerCase();
  if (!q) return 1;

  const label = command.label.toLowerCase();
  const haystack = [
    label,
    command.group,
    command.href || "",
    ...(command.keywords || []),
  ]
    .join(" ")
    .toLowerCase();

  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.every((token) => haystack.includes(token))) return 0;

  let score = 1;
  if (label === q) score += 1000;
  else if (label.startsWith(q)) score += 500;
  else if (label.includes(q)) score += 250;

  for (const token of tokens) {
    const idx = label.indexOf(token);
    score += idx >= 0 ? 100 - idx : 10;
  }
  return score;
}

function useCommands() {
  const { isDark, toggleTheme } = useTheme();
  const isDockerImage = APP_CONFIG.isDockerImage;

  return useMemo(() => {
    const navCommands = NAV_ITEMS.filter(
      (item) => !(isDockerImage && item.hideInDocker)
    ).map((item) => ({
      id: `nav:${item.href}`,
      group: "Navigation",
      label: item.label,
      icon: item.icon,
      href: item.href,
      keywords: ["page", "go"],
    }));

    const mediaCommands = [
      ...MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map(
        (kind) => ({
          id: `media:${kind.id}`,
          group: "System",
          label: kind.label,
          icon: kind.icon,
          href: `/dashboard/media-providers/${kind.id}`,
          keywords: ["media", "provider"],
        })
      ),
      {
        id: `media:${COMBINED_WEB_ITEM.id}`,
        group: "System",
        label: COMBINED_WEB_ITEM.label,
        icon: COMBINED_WEB_ITEM.icon,
        href: COMBINED_WEB_ITEM.href,
        keywords: ["media", "web", "search", "fetch"],
      },
    ];

    const systemCommands = SYSTEM_ITEMS.filter(
      (item) => !(isDockerImage && item.hideInDocker)
    ).map((item) => ({
      id: `sys:${item.href}`,
      group: "System",
      label: item.label,
      icon: item.icon,
      href: item.href,
      keywords: ["page", "go"],
    }));

    const debugCommands = DEBUG_ITEMS.map((item) => ({
      id: `debug:${item.href}`,
      group: "System",
      label: item.label,
      icon: item.icon,
      href: item.href,
      keywords: ["debug", "page"],
    }));

    const settingsCommand = {
      id: `sys:${SETTINGS_ITEM.href}`,
      group: "System",
      label: SETTINGS_ITEM.label,
      icon: SETTINGS_ITEM.icon,
      href: SETTINGS_ITEM.href,
      keywords: ["preferences", "config", "page"],
    };

    const actions = [
      {
        id: "action:theme",
        group: "Actions",
        label: `Switch to ${isDark ? "Light" : "Dark"} mode`,
        icon: isDark ? "light_mode" : "dark_mode",
        keywords: ["theme", "dark", "light", "appearance"],
        run: () => toggleTheme(),
      },
    ];

    return [
      ...navCommands,
      ...mediaCommands,
      ...systemCommands,
      ...debugCommands,
      settingsCommand,
      ...actions,
    ];
  }, [isDockerImage, isDark, toggleTheme]);
}

export default function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const toggle = useCommandPaletteStore((s) => s.toggle);

  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  if (!open) return null;
  return <CommandPaletteDialog />;
}

function CommandPaletteDialog() {
  const router = useRouter();
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  const commands = useCommands();

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef([]);

  // Lock body scroll while open; dialog unmounts on close so cleanup runs.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const grouped = useMemo(() => {
    const matched = commands
      .map((c) => ({ ...c, score: scoreCommand(c, query) }))
      .filter((c) => c.score > 0);

    return GROUP_ORDER.map((group) => {
      const items = matched
        .filter((c) => c.group === group)
        .sort((a, b) => b.score - a.score);
      return { group, items };
    }).filter((section) => section.items.length > 0);
  }, [commands, query]);

  const flat = useMemo(
    () => grouped.flatMap((section) => section.items),
    [grouped]
  );

  // Keep active item in view
  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeIndex, grouped]);

  const runCommand = (command) => {
    if (!command) return;
    setOpen(false);
    if (command.run) command.run();
    if (command.href) router.push(command.href);
  };

  const onInputKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) =>
        flat.length ? (i - 1 + flat.length) % flat.length : 0
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      runCommand(flat[activeIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  let runningIndex = -1;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center p-4 pt-[12vh]">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px] fade-in"
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-xl overflow-hidden rounded-[14px] border border-border-subtle bg-surface shadow-[var(--shadow-elev)] slide-in-top"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 border-b border-border-subtle">
          <span className="material-symbols-outlined text-text-muted text-[20px]">search</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Search pages and actions..."
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={
              flat[activeIndex] ? `command-option-${flat[activeIndex].id}` : undefined
            }
            className="flex-1 h-14 bg-transparent text-[15px] text-text-main placeholder:text-text-subtle focus:outline-none"
          />
          <kbd className="hidden sm:inline-flex items-center rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div
          id="command-palette-list"
          role="listbox"
          className="max-h-[52vh] overflow-y-auto custom-scrollbar py-2"
        >
          {flat.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-4 py-12 text-center">
              <span className="material-symbols-outlined text-text-subtle text-[28px]">
                search_off
              </span>
              <p className="text-sm text-text-muted">No results for “{query}”</p>
            </div>
          ) : (
            grouped.map((section) => (
              <div key={section.group} className="px-2">
                <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted/60">
                  {section.group}
                </p>
                {section.items.map((item) => {
                  runningIndex += 1;
                  const index = runningIndex;
                  const active = index === activeIndex;
                  return (
                    <button
                      key={item.id}
                      id={`command-option-${item.id}`}
                      ref={(el) => {
                        itemRefs.current[index] = el;
                      }}
                      role="option"
                      aria-selected={active}
                      onMouseMove={() => setActiveIndex(index)}
                      onClick={() => runCommand(item)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors",
                        active
                          ? "bg-primary/10 text-primary"
                          : "text-text-main hover:bg-surface-2"
                      )}
                    >
                      <span
                        className={cn(
                          "material-symbols-outlined text-[18px]",
                          active ? "text-primary" : "text-text-muted"
                        )}
                      >
                        {item.icon}
                      </span>
                      <span className="flex-1 text-[13px] font-medium">
                        {item.label}
                      </span>
                      {active && (
                        <span className="material-symbols-outlined text-[16px] text-primary/70">
                          keyboard_return
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 border-t border-border-subtle px-4 py-2 text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-surface-2 px-1 py-0.5">↑</kbd>
            <kbd className="rounded border border-border bg-surface-2 px-1 py-0.5">↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-surface-2 px-1 py-0.5">↵</kbd>
            select
          </span>
          <span className="ml-auto flex items-center gap-1">
            <kbd className="rounded border border-border bg-surface-2 px-1 py-0.5">esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
