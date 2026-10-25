import { SkeletonHeading, SkeletonLine, SkeletonTable } from '@inflect/ui/components/ui/skeleton';

export default function ClientLoading() {
  return (
    <main className="flex flex-col gap-section" aria-busy="true" data-testid="client-loading">
      <div className="flex flex-col gap-tight">
        <SkeletonHeading />
        <SkeletonLine className="w-64" />
      </div>
      <SkeletonTable rows={4} cols={5} />
    </main>
  );
}
