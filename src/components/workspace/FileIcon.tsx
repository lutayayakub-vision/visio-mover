import type { Category } from "../../lib/files";

const PATHS: Record<Category, string> = {
  image: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M9 9a1 1 0 1 0 0 .01",
  video: "M3 6h12v12H3zM15 10l6-3v10l-6-3",
  document: "M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6",
};

export default function FileIcon({ category, size = 22 }: { category: Category; size?: number }) {
  return (
    <span className={`ficon ficon-${category}`} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={PATHS[category]} /></svg>
    </span>
  );
}
