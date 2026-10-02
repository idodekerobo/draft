import Link from "next/link";
export default function DraftLogo({ href = "#top" }: { href?: string }) {
  return (
    <Link href={href} className="minimal-logo" aria-label="Draft home">
      Draft
    </Link>
  );
}
