import gsap from 'gsap';

const reduceMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 弹窗：遮罩渐显 + 面板轻微上浮 */
export function animateOverlay(root: HTMLElement | null) {
  if (!root || reduceMotion()) return;
  gsap.killTweensOf(root);
  gsap.fromTo(root, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.18, ease: 'power1.out' });
  const sheet = root.querySelector('.sheet') as HTMLElement | null;
  if (sheet) {
    gsap.fromTo(
      sheet,
      { y: 14, scale: 0.985, autoAlpha: 0 },
      { y: 0, scale: 1, autoAlpha: 1, duration: 0.24, ease: 'power2.out' },
    );
  }
}

/** 右侧抽屉：从右边滑进来 */
export function animateDrawer(el: HTMLElement | null) {
  if (!el || reduceMotion()) return;
  gsap.fromTo(el, { x: 32, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.24, ease: 'power2.out' });
}

/** 搜索面板 */
export function animatePanel(el: HTMLElement | null) {
  if (!el || reduceMotion()) return;
  gsap.fromTo(el, { y: -8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.2, ease: 'power2.out' });
}

/** 开场白 */
export function animateIntro(el: HTMLElement | null) {
  if (!el || reduceMotion()) return;
  gsap.fromTo(el, { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.32, ease: 'power2.out' });
}

/** toast */
export function animateToast(el: HTMLElement | null) {
  if (!el || reduceMotion()) return;
  gsap.fromTo(el, { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.2, ease: 'power2.out' });
}

/** 新消息轻微上浮 */
export function animateMessage(el: HTMLElement | null) {
  if (!el || reduceMotion()) return;
  gsap.fromTo(el, { y: 6, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.2, ease: 'power1.out' });
}
