export default function Home() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <div className="text-center space-y-4 px-4">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-2">
          <svg
            className="w-8 h-8 text-primary-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
        </div>
        <h1 className="text-4xl font-bold text-foreground tracking-tight">BridgeUp</h1>
        <p className="text-muted-foreground text-lg max-w-md mx-auto">
          Your project is ready. Share your specification and we'll build it out together.
        </p>
        <div className="pt-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground bg-muted px-3 py-1.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Ready for your specification
          </span>
        </div>
      </div>
    </div>
  );
}
