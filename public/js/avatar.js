/* ============================================================
   数字人渲染器：SVG 实时驱动（呼吸 / 眨眼 / 注视 / 口型同步）
   ============================================================ */
(function () {
  "use strict";

  const MOUTH = { cx: 210, cy: 250, half: 25 };

  class DigitalAvatar {
    constructor(svg) {
      this.svg = svg;
      this.state = "idle";
      this.variant = "ava";
      this.energy = null;      // 外部音频能量 0~1；null 表示使用程序化口型
      this.level = 0;          // 平滑后的口型开合
      this.blink = 0;
      this.nextBlink = performance.now() + 2200;
      this.blinkStart = 0;
      this.startTime = performance.now();
      this.raf = null;

      this.head = svg.querySelector("#avHead");
      this.brows = svg.querySelector("#avBrows");
      this.eyes = Array.from(svg.querySelectorAll(".eye"));
      this.irises = Array.from(svg.querySelectorAll(".iris"));
      this.cavity = svg.querySelector("#mouthCavity");
      this.upper = svg.querySelector("#mouthUpper");
      this.lower = svg.querySelector("#mouthLower");
      this.teeth = svg.querySelector("#mouthTeeth");
      this.hairAva = svg.querySelector("#avHairAva");
      this.hairLeo = svg.querySelector("#avHairLeo");
      this.hairBack = svg.querySelector("#avHairBack");

      this.drawMouth(0.02, 0);
      this.loop = this.loop.bind(this);
      this.raf = requestAnimationFrame(this.loop);
    }

    setVariant(variant) {
      this.variant = variant === "leo" ? "leo" : "ava";
      const isLeo = this.variant === "leo";
      this.hairAva.style.display = isLeo ? "none" : "";
      this.hairLeo.style.display = isLeo ? "" : "none";
      this.hairBack.style.display = isLeo ? "none" : "";
    }

    setState(next) {
      this.state = next || "idle";
    }

    setEnergy(value) {
      this.energy = typeof value === "number" ? Math.max(0, Math.min(1, value)) : null;
    }

    drawMouth(open, smile) {
      const { cx, cy, half } = MOUTH;
      const hw = half * (1 + 0.04 * Math.sin(performance.now() / 220));
      const bottom = cy + 5 + open * 30;
      const cornerY = cy - smile * 1.6;

      this.cavity.setAttribute(
        "d",
        `M ${cx - hw} ${cornerY} Q ${cx - hw * 0.55} ${cy - 6} ${cx} ${cy - 5}` +
        ` Q ${cx + hw * 0.55} ${cy - 6} ${cx + hw} ${cornerY}` +
        ` Q ${cx + hw * 0.5} ${bottom} ${cx} ${bottom}` +
        ` Q ${cx - hw * 0.5} ${bottom} ${cx - hw} ${cornerY} Z`
      );
      this.upper.setAttribute(
        "d",
        `M ${cx - hw} ${cornerY} Q ${cx - hw * 0.5} ${cy - 7.5} ${cx} ${cy - 5.5}` +
        ` Q ${cx + hw * 0.5} ${cy - 7.5} ${cx + hw} ${cornerY}`
      );
      this.lower.setAttribute(
        "d",
        `M ${cx - hw} ${cornerY} Q ${cx - hw * 0.5} ${bottom + 1.5} ${cx} ${bottom + 1.5}` +
        ` Q ${cx + hw * 0.5} ${bottom + 1.5} ${cx + hw} ${cornerY}`
      );
      const teethW = Math.max(0, hw * 1.1 * Math.min(1, open * 2.4));
      this.teeth.setAttribute("x", String(cx - teethW / 2));
      this.teeth.setAttribute("width", String(teethW));
      this.teeth.setAttribute("opacity", open > 0.34 ? "0.9" : "0");
    }

    loop(now) {
      const t = (now - this.startTime) / 1000;
      const dt = 1 / 60;

      let target = 0.02;
      let smile = 0.25;

      if (this.state === "speaking") {
        if (this.energy !== null) {
          target = 0.08 + this.energy * 0.92;
        } else {
          // 程序化口型：多频正弦叠加 + 偶尔的停顿，模拟音节节奏
          const gate = Math.sin(t * 1.9) > -0.72 ? 1 : 0.18;
          const wave =
            (Math.sin(t * 12.4) * 0.5 + 0.5) * 0.55 +
            (Math.sin(t * 19.7 + 1.7) * 0.5 + 0.5) * 0.3 +
            (Math.sin(t * 7.3 + 0.4) * 0.5 + 0.5) * 0.15;
          target = 0.1 + wave * 0.85 * gate;
        }
        smile = 0.4 + Math.sin(t * 5) * 0.2;
      } else if (this.state === "listening") {
        target = 0.04 + Math.max(0, this.energy || 0) * 0.2;
        smile = 0.15;
      } else if (this.state === "thinking") {
        target = 0.015;
        smile = 0;
      } else {
        target = 0.015 + (Math.sin(t * 1.1) * 0.5 + 0.5) * 0.02;
      }

      this.level += (target - this.level) * Math.min(1, dt * 14);
      this.drawMouth(this.level, smile);

      // 眨眼
      if (now > this.nextBlink) {
        this.blinkStart = now;
        this.nextBlink = now + 2600 + Math.random() * 3600;
      }
      const bp = (now - this.blinkStart) / 150;
      const blinkScale = bp >= 0 && bp <= 1 ? 1 - Math.sin(bp * Math.PI) * 0.92 : 1;
      this.eyes.forEach((eye, i) => {
        const cy = 193;
        eye.setAttribute("transform", `translate(0 ${cy}) scale(1 ${blinkScale.toFixed(3)}) translate(0 ${-cy})`);
      });

      // 注视方向
      let lookX = 0;
      let lookY = 0;
      if (this.state === "thinking") { lookX = -1.6; lookY = -2.4; }
      else if (this.state === "listening") { lookX = 0.8; lookY = 0.6; }
      else if (this.state === "speaking") { lookX = Math.sin(t * 1.4) * 1.4; lookY = Math.cos(t * 1.1) * 0.8; }
      this.irises.forEach((g) => {
        g.setAttribute("transform", `translate(${lookX.toFixed(2)} ${lookY.toFixed(2)})`);
      });

      // 头部微动
      let dx = 0;
      let dy = Math.sin(t * 1.35) * 1.4;
      let rot = Math.sin(t * 0.55) * 0.5;
      if (this.state === "listening") { dy += 1.6; rot += 1.5; }
      if (this.state === "thinking") { rot -= 2.6; dx -= 1.6; dy -= 1; }
      if (this.state === "speaking") { dy += Math.sin(t * 3.1) * 1.4; rot += Math.sin(t * 1.9) * 1.4; }
      this.head.setAttribute("transform", `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${rot.toFixed(2)} 210 300)`);

      // 眉毛
      let browLift = 0;
      if (this.state === "listening") browLift = -2.6;
      if (this.state === "thinking") browLift = -1.4 + Math.sin(t * 2) * 0.6;
      if (this.state === "speaking") browLift = Math.sin(t * 4.2) * 1.1;
      this.brows.setAttribute("transform", `translate(0 ${browLift.toFixed(2)})`);

      this.raf = requestAnimationFrame(this.loop);
    }

    destroy() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  window.DigitalAvatar = DigitalAvatar;
})();
