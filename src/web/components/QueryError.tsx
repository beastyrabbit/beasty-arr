import { Button } from "./ui/button.js";

export function QueryError({
  query,
}: {
  query: {
    isError: boolean;
    data: unknown;
    refetch: () => Promise<unknown>;
  };
}) {
  if (!query.isError) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-3 border-b border-missing/30 p-3 text-[12px] text-missing"
    >
      <span>
        {query.data === undefined
          ? "Could not load data."
          : "Refresh failed. Showing previously loaded data."}
      </span>
      <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
        Retry
      </Button>
    </div>
  );
}
