export function ArticleSkeleton() {
  return (
    <article className="border-b border-gray-200 pb-6 last:border-0">
      <div className="block p-2 -m-2">
        <div className="flex gap-4">
          <div className="flex-1">
            {/* Title skeleton - 2 lines */}
            <div className="space-y-2 mb-2">
              <div className="h-6 bg-gray-200 rounded animate-pulse w-3/4"></div>
              <div className="h-6 bg-gray-200 rounded animate-pulse w-1/2"></div>
            </div>
            
            {/* Date skeleton */}
            <div className="mb-3">
              <div className="h-4 bg-gray-200 rounded animate-pulse w-48"></div>
            </div>
            
            {/* Content preview skeleton - 3 lines */}
            <div className="space-y-2">
              <div className="h-4 bg-gray-200 rounded animate-pulse w-full"></div>
              <div className="h-4 bg-gray-200 rounded animate-pulse w-5/6"></div>
              <div className="h-4 bg-gray-200 rounded animate-pulse w-2/3"></div>
            </div>
          </div>
          
          {/* Image placeholder */}
          <div className="w-32 h-24 bg-gray-200 rounded animate-pulse flex-shrink-0"></div>
        </div>
      </div>
    </article>
  );
}

export function ArticleListSkeleton() {
  return (
    <div className="grid gap-6">
      <ArticleSkeleton />
      <ArticleSkeleton />
      <ArticleSkeleton />
    </div>
  );
}