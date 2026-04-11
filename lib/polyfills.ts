/**
 * Polyfills for modern JavaScript features required by libraries like pdfjs-dist 5.x
 */

if (typeof Promise.withResolvers === 'undefined') {
  (Promise as any).withResolvers = function() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
