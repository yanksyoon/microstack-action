/**
 * Wait for a number of milliseconds.
 * @param milliseconds The number of milliseconds to wait.
 * @returns {Promise<string>} Resolves with 'done!' after the wait is over.
 */
export async function wait(milliseconds: number): Promise<string> {
  return new Promise(resolve => {
    if (isNaN(milliseconds)) {
      throw new Error('milliseconds not a number')
    }

    setTimeout(() => resolve('done!'), milliseconds)
  })
}

export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number
) {
  const start = Date.now()
  while (true) {
    const result = await condition()
    if (result) return true
    // Check for timeout
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timeout exceeded while waiting for condition to be true')
    }
    // Wait a bit before checking again to avoid busy waiting
    await new Promise(resolve => setTimeout(resolve, 50)) // Wait 50ms
  }
}
