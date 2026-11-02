import { useEffect, useState } from "react";

/** ".", "..", "...", and round again: a wait that is moving, so it is not mistaken for a hang. */
export function Dots(): JSX.Element {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const timer = setInterval(() => setCount((n) => (n % 3) + 1), 400);
    return () => clearInterval(timer);
  }, []);
  return <span className="qa-dots" aria-hidden="true">{".".repeat(count)}</span>;
}
