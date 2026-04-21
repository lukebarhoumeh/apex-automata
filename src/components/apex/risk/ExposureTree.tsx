import type { ExposureNode } from "@/types/risk";

interface Props {
  node: ExposureNode;
  depth?: number;
  maxVal: number;
  parentVal?: number;
}

const COLORS = ["bg-accent", "bg-accent-2", "bg-up", "bg-warn"] as const;

export function ExposureTree({ node, depth = 0, maxVal, parentVal }: Props) {
  const pct = parentVal ? (node.value / parentVal) * 100 : (node.value / maxVal) * 100;
  const barClass = COLORS[depth % COLORS.length];
  const opacity = Math.min(1, 0.45 + depth * 0.15);

  return (
    <div>
      <div
        className="grid items-center gap-3 py-1.5"
        style={{ gridTemplateColumns: `${depth * 16 + 160}px 1fr 96px` }}
      >
        <div
          className="truncate text-[12.5px]"
          style={{
            paddingLeft: depth * 16,
            fontWeight: depth === 0 ? 600 : 400,
            color: depth === 0 ? "hsl(var(--fg-0))" : "hsl(var(--fg-1))",
          }}
        >
          {depth > 0 && <span className="mr-1.5 text-fg-3">└</span>}
          {node.label}
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-obsidian-3">
          <div
            className={`h-full rounded-full ${barClass}`}
            style={{ width: `${pct}%`, opacity }}
          />
        </div>
        <div className="mono text-right text-[12px] text-fg-0">
          ${node.value.toLocaleString()}
        </div>
      </div>
      {node.children?.map((c, i) => (
        <ExposureTree
          key={`${c.label}-${i}`}
          node={c}
          depth={depth + 1}
          maxVal={maxVal}
          parentVal={node.value}
        />
      ))}
    </div>
  );
}
