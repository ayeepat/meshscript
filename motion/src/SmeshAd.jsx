import React from 'react';
import {Audio} from '@remotion/media';
import {
  AbsoluteFill,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import {SMESH_AD_SOUNDTRACK} from './composition.mjs';
import {RELEASE_ASSETS} from './release-assets.mjs';

const C = {
  paper: '#f7f4ee',
  ink: '#2a2620',
  muted: '#6b6354',
  teal: '#1f8f8b',
  tealDark: '#176f6c',
  tealSoft: '#d8ece9',
  green: '#15201f',
  cream: '#fffdf8',
  chromeBlue: '#0b57d0',
};

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};
const ip = (frame, input, output, easing = Easing.inOut(Easing.cubic)) =>
  interpolate(frame, input, output, {...clamp, easing});

const sceneOpacity = (frame, start, end, fadeIn = 14, fadeOut = 14) =>
  Math.min(
    ip(frame, [start, start + fadeIn], [0, 1], Easing.out(Easing.cubic)),
    ip(frame, [end - fadeOut, end], [1, 0], Easing.in(Easing.cubic)),
  );

const PaperBackground = ({dark = false, children, style}) => (
  <AbsoluteFill
    style={{
      overflow: 'hidden',
      backgroundColor: dark ? C.green : C.paper,
      backgroundImage: dark
        ? 'radial-gradient(circle at 20% 18%, rgba(79,209,197,.18), transparent 34%), radial-gradient(circle at 82% 78%, rgba(79,209,197,.07), transparent 31%), linear-gradient(135deg, #15201f 0%, #101918 100%)'
        : 'radial-gradient(circle at 86% 10%, rgba(31,143,139,.13), transparent 33%), radial-gradient(circle at 9% 86%, rgba(181,155,92,.11), transparent 31%), linear-gradient(135deg, #faf8f2 0%, #f4f0e8 100%)',
      ...style,
    }}
  >
    <div className="paper-fibres" />
    {children}
  </AbsoluteFill>
);

const Logo = ({size = 150, style}) => (
  <Img
    src={staticFile(RELEASE_ASSETS.logo.path)}
    style={{width: size, height: size, objectFit: 'contain', ...style}}
  />
);

const TimedVideo = ({asset, style}) => (
  <Sequence
    from={asset.scene.startFrame}
    durationInFrames={asset.scene.durationInFrames}
    layout="none"
    premountFor={24}
  >
    <OffthreadVideo
      src={staticFile(asset.path)}
      trimBefore={asset.scene.trimBefore}
      playbackRate={asset.scene.playbackRate}
      muted
      style={style}
    />
  </Sequence>
);

const BrowserCard = ({x, y, width, height, opacity = 1, scale = 1, rotate = 0, children, style}) => (
  <div
    className="browser-card"
    style={{
      left: x,
      top: y,
      width,
      height,
      opacity,
      transform: `scale(${scale}) rotate(${rotate}deg)`,
      ...style,
    }}
  >
    {children}
  </div>
);

// The source recordings show the journal provider's wordmark in the fixed
// header. Keep the real interface footage, but neutralise only that small
// rectangle in the public ad so the provider is not presented as part of the
// product brand.
const JournalBrandMask = ({left, top = 0, width, height, color, opacity = 1}) => (
  <div
    aria-hidden="true"
    style={{position: 'absolute', zIndex: 4, left, top, width, height, background: color, opacity}}
  />
);

const SceneCopy = ({frame, start, eyebrow, title, accent, subtitle, className = ''}) => {
  const enter = ip(frame, [start, start + 24], [0, 1], Easing.out(Easing.cubic));
  return (
    <div className={`scene-copy ${className}`} style={{opacity: enter, transform: `translateY(${(1 - enter) * 32}px)`}}>
      <div className="eyebrow">{eyebrow}</div>
      <div className="scene-title">{title}<br /><em>{accent}</em></div>
      <div className="scene-subtitle">{subtitle}</div>
    </div>
  );
};

const StoreOpening = ({frame}) => {
  const opacity = ip(frame, [128, 147], [1, 0], Easing.inOut(Easing.cubic));
  const zoom = ip(frame, [52, 128], [0, 1], Easing.inOut(Easing.poly(4)));
  const scale = 0.985 + zoom * 5.2;
  const dx = (960 - 1594) * zoom;
  const dy = (540 - 218) * zoom;
  const intro = spring({frame, fps: 60, config: {damping: 21, stiffness: 76, mass: 1}});
  const cursorTravel = ip(frame, [48, 102], [0, 1], Easing.inOut(Easing.cubic));
  const buttonX = 1594 + (960 - 1594) * zoom;
  const buttonY = 218 + (540 - 218) * zoom;
  const cursorX = ip(cursorTravel, [0, 1], [1395, buttonX + 8]);
  const cursorY = ip(cursorTravel, [0, 1], [345, buttonY + 7]);
  const click = ip(frame, [106, 113, 121], [0, 1, 0], Easing.out(Easing.cubic));
  const sparks = ip(frame, [111, 116, 126], [0, 1, 0], Easing.out(Easing.cubic));

  return (
    <AbsoluteFill style={{overflow: 'hidden', background: C.paper, opacity}}>
      <div
        className="store-stage"
        style={{
          opacity: 0.88 + intro * 0.12,
          transformOrigin: '83.03% 20.18%',
          transform: `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`,
        }}
      >
        <Img src={staticFile(RELEASE_ASSETS.store.path)} className="store-image" />
        <div className="store-user-mask" />
      </div>
      <div
        className="store-cursor"
        style={{left: cursorX, top: cursorY, transform: `scale(${1 - click * .18})`}}
      />
      <div className="click-sparks" style={{left: cursorX + 10, top: cursorY + 8, opacity: sparks, transform: `scale(${.7 + sparks * .45})`}}>
        <i /><i /><i /><i />
      </div>
    </AbsoluteFill>
  );
};

const ConnectTransition = ({frame}) => {
  if (frame < 108 || frame > 208) return null;
  const backdrop = ip(frame, [108, 120, 166, 188], [0, 1, 1, 0], Easing.inOut(Easing.cubic));
  const teal = ip(frame, [119, 142], [0, 1], Easing.out(Easing.poly(5)));
  const paper = ip(frame, [135, 166], [0, 1], Easing.out(Easing.poly(5)));
  const pillIn = spring({frame: frame - 122, fps: 60, config: {damping: 16, stiffness: 128, mass: .74}});
  const dock = ip(frame, [154, 188], [0, 1], Easing.inOut(Easing.cubic));
  const x = ip(dock, [0, 1], [960, 255]);
  const y = ip(dock, [0, 1], [540, 94]);
  const pillOpacity = ip(frame, [121, 134, 188, 204], [0, 1, 1, 0]);

  return (
    <AbsoluteFill style={{zIndex: 25, pointerEvents: 'none'}}>
      <AbsoluteFill style={{overflow: 'hidden', opacity: backdrop, background: C.chromeBlue}}>
        <div className="expanding-disc" style={{width: 2450 * teal, height: 2450 * teal, background: C.teal}} />
        <div className="expanding-disc" style={{width: 2600 * paper, height: 2600 * paper, background: C.paper}} />
      </AbsoluteFill>
      <div
        className="connected-pill"
        style={{
          left: x,
          top: y,
          opacity: pillOpacity,
          transform: `translate(-50%, -50%) scale(${(.72 + pillIn * .28) * (1 - dock * .26)})`,
        }}
      >
        <Logo size={72} />
        <div>
          <div className="connected-title">СМЭШ AI</div>
          <div className="connected-sub">подключён</div>
        </div>
        <div className="connected-check">✓</div>
      </div>
    </AbsoluteFill>
  );
};

const TransitionSweep = ({frame, start, reverse = false}) => {
  const duration = 18;
  if (frame < start || frame > start + duration) return null;
  const p = ip(frame, [start, start + duration], [0, 1], Easing.inOut(Easing.cubic));
  const travel = reverse ? 1 - p : p;
  return (
    <div
      className="transition-sweep"
      style={{left: -3000 + travel * 6000}}
    />
  );
};

const TestScene = ({frame}) => {
  const {scene} = RELEASE_ASSETS.testScan;
  const {startFrame: start, endFrame: end} = scene;
  const opacity = sceneOpacity(frame, start, end, 16, 8);
  const enter = spring({frame: frame - start, fps: 60, config: {damping: 19, stiffness: 88, mass: .92}});
  const scan = ip(frame, [217, 326], [0, 1], Easing.inOut(Easing.cubic));
  const scanOpacity = ip(frame, [205, 219, 326, 342], [0, 1, 1, 0]);

  return (
    <PaperBackground style={{opacity}}>
      <SceneCopy
        frame={frame}
        start={188}
        eyebrow="РАБОТАЕТ В ЭЛЕКТРОННОМ ЖУРНАЛЕ"
        title="ВИДИТ"
        accent="ТЕСТ."
        subtitle={<>Сканирует страницу<br />и понимает задания.</>}
      />
      <BrowserCard
        x={535}
        y={144}
        width={1320}
        height={714}
        scale={.93 + enter * .07}
        rotate={(1 - enter) * 1.6}
      >
        <TimedVideo
          asset={RELEASE_ASSETS.testScan}
          style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'}}
        />
        <JournalBrandMask left={130} width={105} height={44} color="#2d3956" />
        <div className="scan-line" style={{top: `${8 + scan * 82}%`, opacity: scanOpacity}} />
        <div className="scan-label" style={{top: `${5 + scan * 82}%`, opacity: scanOpacity}}>сканирую</div>
      </BrowserCard>
    </PaperBackground>
  );
};

const AnswerScene = ({frame}) => {
  const {scene} = RELEASE_ASSETS.testAnswers;
  const {startFrame: start, endFrame: end} = scene;
  const opacity = sceneOpacity(frame, start, end, 7, 9);
  const enter = spring({frame: frame - start, fps: 60, config: {damping: 20, stiffness: 84, mass: .95}});
  const proof = ip(frame, [382, 405], [0, 1], Easing.out(Easing.cubic));

  return (
    <PaperBackground style={{opacity}}>
      <BrowserCard
        x={105}
        y={72}
        width={1710}
        height={925}
        scale={.95 + enter * .05}
        rotate={(1 - enter) * -1.1}
      >
        <TimedVideo
          asset={RELEASE_ASSETS.testAnswers}
          style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'}}
        />
        <JournalBrandMask left={175} width={120} height={50} color="#2d3956" />
        <div className="proof-pill" style={{opacity: proof, transform: `translateY(${(1 - proof) * 16}px)`}}>ответы готовы <span>✓</span></div>
      </BrowserCard>
      <div className="answer-copy-panel">
        <div className="eyebrow">ПОКА ТЫ СМОТРИШЬ</div>
        <div className="answer-title">НАХОДИТ<br /><em>ОТВЕТЫ.</em></div>
        <div className="answer-sub">Коротко. По номерам.<br />Без лишних окон.</div>
      </div>
    </PaperBackground>
  );
};

const AutofillScene = ({frame}) => {
  const {scene} = RELEASE_ASSETS.testFill;
  const {startFrame: start, endFrame: end} = scene;
  const opacity = sceneOpacity(frame, start, end, 8, 16);
  const enter = spring({frame: frame - start, fps: 60, config: {damping: 19, stiffness: 95, mass: .86}});
  const highlight = ip(frame, [548, 580], [0, 1], Easing.out(Easing.cubic));
  const ticks = [
    {left: 1025, top: 452, at: 651},
    {left: 1025, top: 666, at: 658},
    {left: 1025, top: 875, at: 665},
  ];

  return (
    <PaperBackground style={{opacity}}>
      <BrowserCard x={100} y={66} width={1720} height={929} scale={.93 + enter * .07} rotate={(1 - enter) * 1.3}>
        <TimedVideo
          asset={RELEASE_ASSETS.testFill}
          style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'}}
        />
        <JournalBrandMask left={175} width={120} height={50} color="#2d3956" />
      </BrowserCard>
      {ticks.map((tick, index) => {
        const p = spring({frame: frame - tick.at, fps: 60, config: {damping: 17, stiffness: 150, mass: .65}});
        return (
          <div
            key={index}
            className="aligned-tick"
            style={{left: tick.left, top: tick.top, opacity: p, transform: `scale(${.7 + p * .3})`}}
          >✓</div>
        );
      })}
      <div className="autofill-panel">
        <div className="eyebrow">ОДНО НАЖАТИЕ</div>
        <div className="autofill-title">ЗАПОЛНЯЕТ</div>
        <div className="autofill-accent">
          <div className="highlighter" style={{transform: `scaleX(${highlight})`}} />
          <em>САМ.</em>
        </div>
        <div className="autofill-sub">Все видимые поля<br />точно по своим местам.</div>
      </div>
    </PaperBackground>
  );
};

const PdfScene = ({frame}) => {
  const {scene} = RELEASE_ASSETS.homeworkPopup;
  const {startFrame: start, endFrame: end} = scene;
  const opacity = sceneOpacity(frame, start, end, 8, 10);
  const enter = spring({frame: frame - start, fps: 60, config: {damping: 19, stiffness: 88, mass: .92}});
  const result = ip(frame, [760, 779], [0, 1], Easing.inOut(Easing.cubic));
  const chip = ip(frame, [784, 803], [0, 1], Easing.out(Easing.cubic));

  return (
    <PaperBackground style={{opacity}}>
      <SceneCopy
        frame={frame}
        start={718}
        eyebrow="ИЗ ДОМАШНЕГО ЗАДАНИЯ"
        title="ДОСТАЁТ"
        accent="PDF."
        subtitle={<>Находит файл<br />и сразу передаёт в работу.</>}
        className="pdf-copy"
      />
      <BrowserCard x={525} y={122} width={1325} height={717} scale={.94 + enter * .06} rotate={(1 - enter) * 1.4}>
        <TimedVideo
          asset={RELEASE_ASSETS.homeworkPopup}
          style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'}}
        />
        <JournalBrandMask left={85} top={8} width={95} height={48} color="#fff" />
        <Img
          src={staticFile(RELEASE_ASSETS.pdfDone.path)}
          style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: result}}
        />
        <div className="pdf-chip-focus" style={{opacity: chip, transform: `scale(${.96 + chip * .04})`}} />
        <div className="pdf-ready" style={{opacity: chip, transform: `translateY(${(1 - chip) * 14}px)`}}>PDF найден <span>✓</span></div>
      </BrowserCard>
    </PaperBackground>
  );
};

const GdzScene = ({frame}) => {
  const {scene} = RELEASE_ASSETS.gdzResult;
  const {startFrame: start, endFrame: end} = scene;
  const opacity = sceneOpacity(frame, start, end, 8, 14);
  const enter = spring({frame: frame - start, fps: 60, config: {damping: 19, stiffness: 86, mass: .94}});
  const badge = ip(frame, [930, 951], [0, 1], Easing.out(Easing.cubic));

  return (
    <PaperBackground style={{opacity}}>
      <SceneCopy
        frame={frame}
        start={899}
        eyebrow="ЗНАЕТ ТВОИ УЧЕБНИКИ"
        title="НАХОДИТ"
        accent="ГДЗ."
        subtitle={<>Подбирает нужное решение<br />и показывает фото страниц.</>}
        className="gdz-copy"
      />
      <BrowserCard x={525} y={112} width={1325} height={756} scale={.94 + enter * .06} rotate={(1 - enter) * -1.4}>
        <TimedVideo
          asset={RELEASE_ASSETS.gdzResult}
          style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'}}
        />
        <div className="gdz-badge" style={{opacity: badge, transform: `translateY(${(1 - badge) * 14}px)`}}>2 задания найдено <span>✓</span></div>
      </BrowserCard>
    </PaperBackground>
  );
};

const EndScene = ({frame}) => {
  const start = 1048;
  const reveal = ip(frame, [start, 1084], [0, 1], Easing.out(Easing.poly(5)));
  const logo = spring({frame: frame - 1058, fps: 60, config: {damping: 16, stiffness: 100, mass: .84}});
  const text = ip(frame, [1078, 1102], [0, 1], Easing.out(Easing.cubic));
  const button = spring({frame: frame - 1100, fps: 60, config: {damping: 18, stiffness: 122, mass: .78}});

  return (
    <AbsoluteFill style={{zIndex: 20, clipPath: `circle(${reveal * 84}% at 50% 50%)`, opacity: ip(frame, [start, start + 6], [0, 1])}}>
      <PaperBackground dark>
        <svg className="end-rings" viewBox="0 0 1920 1080" aria-hidden="true">
          <circle cx="960" cy="412" r="270" />
          <circle cx="960" cy="412" r="390" />
        </svg>
        <Logo size={232} style={{position: 'absolute', left: 844, top: 145, opacity: logo, transform: `scale(${.62 + logo * .38}) rotate(${(1 - logo) * -14}deg)`}} />
        <div className="end-wordmark" style={{opacity: text, transform: `translateY(${(1 - text) * 28}px)`}}>СМЭШ AI</div>
        <div className="end-tagline" style={{opacity: text}}>Домашка без лишних движений.</div>
        <div className="end-button" style={{opacity: button, transform: `translateX(-50%) scale(${.8 + button * .2})`}}>Добавить в Chrome <span>↗</span></div>
      </PaperBackground>
    </AbsoluteFill>
  );
};

export const SmeshAd = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{background: C.paper}}>
      <Audio src={staticFile(SMESH_AD_SOUNDTRACK)} volume={0.82} />
      <StoreOpening frame={frame} />
      <TestScene frame={frame} />
      <ConnectTransition frame={frame} />
      <AnswerScene frame={frame} />
      <AutofillScene frame={frame} />
      <PdfScene frame={frame} />
      <GdzScene frame={frame} />
      <EndScene frame={frame} />
      <TransitionSweep frame={frame} start={335} />
      <TransitionSweep frame={frame} start={692} reverse />
      <TransitionSweep frame={frame} start={870} />
      <div className="global-grade" />
    </AbsoluteFill>
  );
};
