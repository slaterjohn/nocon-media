import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-md p-10 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-muted-foreground">That address doesn't exist. Check the link, or go back to the start.</p>
      <Link href="/" className="mt-4 inline-block underline">Go to home</Link>
    </main>
  );
}
