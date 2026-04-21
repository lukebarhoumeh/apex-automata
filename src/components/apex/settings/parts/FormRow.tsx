import type { ReactNode } from "react";

interface Props {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function FormRow({ label, hint, children }: Props) {
  return (
    <div
      className="grid items-start gap-5 border-b border-obsidian-line px-5 py-3.5"
      style={{ gridTemplateColumns: "220px 1fr" }}
    >
      <div>
        <div className="text-[12.5px] font-medium text-fg-0">{label}</div>
        {hint && <div className="mt-1 text-[11px] leading-[1.4] text-fg-2">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}
