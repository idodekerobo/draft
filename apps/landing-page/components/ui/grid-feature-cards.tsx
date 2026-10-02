import { useId, type ComponentType, type SVGProps } from "react";

export type Feature = {
  title: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  description: string;
};

export function FeatureCard({ feature, index = 0 }: { feature: Feature; index?: number }) {
  const patternId = useId();
  const Icon = feature.icon;
  // Stable coordinates keep server rendering and hydration identical.
  const squares = Array.from({ length: 5 }, (_, i) => [
    7 + ((index * 3 + i * 7) % 4),
    1 + ((index * 5 + i * 3) % 6),
  ]);

  return (
    <article className="feature-card">
      <div className="feature-card-pattern" aria-hidden="true">
        <svg width="100%" height="100%">
          <defs>
            <pattern id={patternId} width="32" height="32" patternUnits="userSpaceOnUse" x="-12" y="4">
              <path d="M.5 32V.5H32" fill="none" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${patternId})`} strokeWidth="0" />
          {squares.map(([x, y], i) => (
            <rect key={i} x={x * 32 - 12} y={y * 32 + 4} width="32" height="32" className="feature-pattern-square" strokeWidth="0" />
          ))}
        </svg>
      </div>
      <Icon className="feature-card-icon" strokeWidth={1} aria-hidden="true" />
      <h3>{feature.title}</h3>
      <p>{feature.description}</p>
    </article>
  );
}
