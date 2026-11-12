import { DietaryType } from '@autonex/shared';

export function DietaryBadge({ type }: { type: DietaryType | string }) {
  if (type === DietaryType.VEG) {
    return (
      <span
        title="Vegetarian"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border border-emerald-600"
      >
        <span className="h-2 w-2 rounded-full bg-emerald-600" />
      </span>
    );
  }
  if (type === DietaryType.EGG) {
    return (
      <span
        title="Egg"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border border-amber-500"
      >
        <span className="h-2 w-2 rounded-full bg-amber-500" />
      </span>
    );
  }
  return (
    <span
      title="Non-Vegetarian"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border border-rose-600"
    >
      <span className="h-2 w-2 rounded-full bg-rose-600" />
    </span>
  );
}

