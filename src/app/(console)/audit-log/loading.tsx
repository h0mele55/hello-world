import { SkeletonCard, SkeletonHeading, SkeletonTable } from '@inflect/ui/components/ui/skeleton';

export default function AuditLogLoading() {
  return (
    <main className="flex flex-col gap-section" aria-busy="true" data-testid="audit-log-loading">
      <SkeletonHeading />
      <div className="grid gap-default lg:grid-cols-2">
        <SkeletonCard lines={3} />
        <SkeletonCard lines={3} />
      </div>
      <SkeletonTable rows={10} cols={5} />
    </main>
  );
}
