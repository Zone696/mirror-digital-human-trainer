/* ============================================================
   数字人渲染器：写实照片 + SVG 口型叠加（呼吸 / 头部微动 / 嘴型同步）
   ============================================================ */
(function () {
  "use strict";

  const VARIANTS = {
    ava: {
      cx: 845,
      cy: 1230,
      half: 105,
      openPx: 70,
      patch: { rx: 165, ry: 100, fill: "#fbe7dc" },
      lip: "#8a4a42",
      lipLower: "#a85a50",
      cavity: "#6b3230",
      imgId: "avatarImgAva",
    },
    leo: {
      cx: 850,
      cy: 1280,
      half: 115,
      openPx: 65,
      patch: { rx: 175, ry: 100, fill: "#fbe9dd" },
      lip: "#7f463f",
      lipLower: "#9a554c",
      cavity: "#5f2e2c",
      imgId: "avatarImgLeo",
    },
  };

  class DigitalAvatar {
    constructor(svg) {
      this.svg = svg;
      this.container = svg.closest(".avatar-photo");
      this.imgs = {
        ava: document.getElementById("avatarImgAva"),
        leo: document.getElementById("avatarImgLeo"),
      };
      this.mouth = svg.querySelector("#avMouth");
      this.patch = svg.querySelector("#mouthPatch");
      this.cavity = svg.querySelector("#mouthCavity");
      this.upper = svg.querySelector("#mouthUpper");
      this.lower = svg.querySelector("#mouthLower");
      this.teeth = svg.querySelector("#mouthTeeth");

      this.state = "idle";
      this.variant = "ava";
      this.cfg = VARIANTS.ava;
      this.energy = null;
      this.level = 0;
      this.startTime = performance.now();
      this.raf = null;

      this.drawMouth(0.02, 0);
      this.loop = this.loop.bind(this);
      this.raf = requestAnimationFrame(this.loop);
    }

    setVariant(variant) {
      this.variant = variant === "leo" ? "leo" : "ava";
      this.cfg = VARIANTS[this.variant];
      const c = this.cfg;

      if (this.imgs.ava) this.imgs.ava.hidden = this.variant !== "ava";
      if (this.imgs.leo) this.imgs.leo.hidden = this.variant !== "leo";

      if (this.patch) {
        this.patch.setAttribute("cx", c.cx);
        this.patch.setAttribute("cy", c.cy);
        this.patch.setAttribute("rx", c.patch.rx);
        this.patch.setAttribute("ry", c.patch.ry);
        this.patch.setAttribute("fill", c.patch.fill);
      }
      if (this.cavity) this.cavity.setAttribute("fill", c.cavity);
      if (this.upper) this.upper.setAttribute("stroke", c.lip);
      if (this.lower) this.lower.setAttribute("stroke", c.lipLower);
      this.drawMouth(this.level, 0.25);
    }

    setState(next) {
      this.state = next || "idle";
    }

    setEnergy(value) {
      this.energy = typeof value === "number" ? Math.max(0, Math.min(1, value)) : null;
    }

    drawMouth(open, smile) {
      const { cx, cy, half, openPx } = this.cfg;
      const hw = half * (1 + 0.05 * Math.sin(performance.now() / 220));
      const bottom = cy + 8 + open * openPx;
      const cornerY = cy - smile * 6;

      this.cavity.setAttribute(
        "d",
        `M ${cx - hw} ${cornerY} Q ${cx - hw * 0.55} ${cy - 22} ${cx} ${cy - 18}` +
          ` Q ${cx + hw * 0.55} ${cy - 22} ${cx + hw} ${cornerY}` +
          ` Q ${cx + hw * 0.5} ${bottom} ${cx} ${bottom}` +
          ` Q ${cx - hw * 0.5} ${bottom} ${cx - hw} ${cornerY} Z`
      );
      this.upper.setAttribute(
        "d",
        `M ${cx - hw} ${cornerY} Q ${cx - hw * 0.5} ${cy - 26} ${cx} ${cy - 20}` +
          ` Q ${cx + hw * 0.5} ${cy - 26} ${cx + hw} ${cornerY}`
      );
      this.lower.setAttribute(
        "d",
        `M ${cx - hw} ${cornerY} Q ${cx - hw * 0.5} ${bottom + 5} ${cx} ${bottom + 5}` +
          ` Q ${cx + hw * 0.5} ${bottom + 5} ${cx + hw} ${cornerY}`
      );
      const teethW = Math.max(0, hw * 1.1 * Math.min(1, open * 2.4));
      this.teeth.setAttribute("x", String(cx - teethW / 2));
      this.teeth.setAttribute("y", String(cy - 16));
      this.teeth.setAttribute("width", String(teethW));
      this.teeth.setAttribute("opacity", open > 0.55 ? "0.55" : "0");
      // 开合小时完全隐藏，露出真实闭唇照片
      if (this.mouth) {
        this.mouth.setAttribute("opacity", Math.min(1, Math.max(0, (open - 0.08) * 5)).toFixed(3));
      }
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
          const gate = Math.sin(t * 1.9) > -0.72 ? 1 : 0.18;
          const wave =
            (Math.sin(t * 12.4) * 0.5 + 0.5) * 0.55 +
            (Math.sin(t * 19.7 + 1.7) * 0.5 + 0.5) * 0.3 +
            (Math.sin(t * 7.3 + 0.4) * 0.5 + 0.5) * 0.15;
          target = 0.1 + wave * 0.85 * gate;
        }
        smile = 0.4 + Math.sin(t * 5) * 0.2;
      } else if (this.state === "listening") {
        target = 0.02;
        smile = 0.2;
      } else if (this.state === "thinking") {
        target = 0.015;
        smile = 0;
      } else {
        target = 0.015;
      }

      this.level += (target - this.level) * Math.min(1, dt * 14);
      this.drawMouth(this.level, smile);

      // 头部微动：作用于整张照片容器，保证口型绝对对齐
      if (this.container) {
        let dy = Math.sin(t * 1.2) * 3;
        let rot = Math.sin(t * 0.5) * 0.4;
        if (this.state === "listening") {
          dy += 2;
          rot += 0.8;
        }
        if (this.state === "thinking") {
          rot -= 1.2;
          dy -= 1;
        }
        if (this.state === "speaking") {
          dy += Math.sin(t * 3.1) * 1.6;
          rot += Math.sin(t * 1.9) * 0.7;
        }
        this.container.style.transform = `translateY(${dy.toFixed(2)}px) rotate(${rot.toFixed(2)}deg) scale(1.04)`;
      }

      this.raf = requestAnimationFrame(this.loop);
    }

    destroy() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  window.DigitalAvatar = DigitalAvatar;
})();
