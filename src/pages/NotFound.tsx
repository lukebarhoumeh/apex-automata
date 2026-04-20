import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="p-10">
      <h1 className="font-serif italic text-5xl text-fg-0 tracking-tight">404</h1>
      <p className="mt-3 text-fg-2 text-sm">That route does not exist.</p>
      <Link to="/" className="mt-6 inline-block text-accent hover:underline text-sm">
        Back to Dashboard
      </Link>
    </div>
  );
}
