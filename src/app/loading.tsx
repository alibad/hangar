export default function Loading() {
  return (
    <main className="min-h-screen bg-gray-950 px-6 py-8 text-gray-100" aria-label="Loading Hangar">
      <div className="mx-auto max-w-7xl animate-pulse space-y-5">
        <div className="h-12 rounded-xl bg-gray-900" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((item) => <div key={item} className="h-20 rounded-xl bg-gray-900" />)}
        </div>
        <div className="h-40 rounded-xl bg-gray-900" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((item) => <div key={item} className="h-36 rounded-xl bg-gray-900" />)}
        </div>
      </div>
    </main>
  );
}
