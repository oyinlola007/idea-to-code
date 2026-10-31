/**
 * Waits for an animation, but never longer than `ms`. An interrupted viewport
 * animation never resolves its promise, and whoever awaits it would hang forever.
 */
export function settle(animation: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      resolve();
    };
    setTimeout(finish, ms);
    animation.then(finish, finish);
  });
}
