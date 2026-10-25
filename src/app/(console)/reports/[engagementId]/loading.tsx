import { SkeletonCard, SkeletonHeading, SkeletonLine } from '@inflect/ui/components/ui/skeleton';

export default function EngagementLoading() {
  return (
    <main className="flex flex-col gap-section" aria-busy="true" data-testid="engagement-loading">
      <div className="flex flex-col gap-tight">
        <SkeletonLine className="w-40" />
        <SkeletonHeading />
      </div>
      <SkeletonCard lines={6} />
    </main>
  );
}
