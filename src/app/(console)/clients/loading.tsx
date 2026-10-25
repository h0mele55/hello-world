import { SkeletonHeading, SkeletonTable } from '@inflect/ui/components/ui/skeleton';

export default function ClientsLoading() {
  return (
    <main className="flex flex-col gap-section" aria-busy="true" data-testid="clients-loading">
      <SkeletonHeading />
      <SkeletonTable rows={8} cols={6} />
    </main>
  );
}
