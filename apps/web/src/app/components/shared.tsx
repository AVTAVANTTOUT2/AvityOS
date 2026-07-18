export function cn(...c: (string | undefined | false | null)[]) {
  return c.filter(Boolean).join(" ");
}

export function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    good: "bg-green-400", healthy: "bg-green-400", available: "bg-green-400",
    warning: "bg-orange-400", blocked: "bg-red-400", error: "bg-red-400",
    planning: "bg-blue-400", execution: "bg-[#5267D9]", validation: "bg-purple-400",
    offline: "bg-gray-300", approved: "bg-green-400", merged: "bg-purple-400",
  };
  return <span className={cn("inline-block w-2 h-2 rounded-full flex-shrink-0", map[status] ?? "bg-gray-300")} />;
}

export function Bar2({ value, color = "bg-[#5267D9]" }: { value: number; color?: string }) {
  return (
    <div className="h-1.5 bg-black/[0.06] rounded-full overflow-hidden">
      <div className={cn("h-full rounded-full transition-all duration-500", color)} style={{ width: `${Math.min(value, 100)}%` }} />
    </div>
  );
}

export function Glass({ className, children, onClick }: { className?: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "bg-white/80 backdrop-blur-xl rounded-2xl border border-white/70 shadow-[0_2px_24px_rgba(0,0,0,0.05)]",
        onClick && "cursor-pointer hover:shadow-[0_4px_32px_rgba(0,0,0,0.09)] transition-shadow",
        className,
      )}
    >
      {children}
    </div>
  );
}
