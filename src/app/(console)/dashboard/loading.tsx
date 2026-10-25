import { SkeletonCard, SkeletonHeading, SkeletonKpiGrid } from '@inflect/ui/components/ui/skeleton';

export default function DashboardLoading() {
  return (
    <main className="flex flex-col gap-section" aria-busy="true" data-testid="dashboard-loading">
      <SkeletonHeading />
      <SkeletonKpiGrid count={4} />
      <SkeletonCard lines={8} />
    </main>
  );
}
