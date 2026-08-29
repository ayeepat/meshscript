import React, {useEffect, useState} from 'react';
import {
  AbsoluteFill,
  Composition,
  Img,
  continueRender,
  delayRender,
  registerRoot,
  staticFile,
} from 'remotion';
import './styles.css';

const A = (name) => staticFile(`store-listing-2026/${name}`);

const shots = [
  {
    id: '01-homework',
    eyebrow: 'ДОМАШНИЕ ЗАДАНИЯ',
    title: ['ВСЯ ДОМАШКА', 'НА НЕДЕЛЮ'],
    accentLine: 1,
    description: 'Задания собраны по дням в одном окне.',
    image: 'homework-popup.png',
    imageClass: 'shot-homework',
    focus: {left: 476, top: 76, width: 300, height: 435},
  },
  {
    id: '02-test-fill',
    eyebrow: 'ТЕСТЫ МЭШ',
    title: ['ЗАПОЛНЯЕТ', 'ПОЛЯ ТЕСТА'],
    accentLine: 1,
    description: 'Ответы остаётся проверить. Кнопку сдачи нажимаете вы.',
    image: 'test-done.png',
    imageClass: 'shot-test',
    privacyMask: true,
    focus: {left: 460, top: 226, width: 355, height: 401},
  },
  {
    id: '03-files',
    eyebrow: 'ФАЙЛЫ И ФОТО',
    title: ['БЕРЁТ', 'ФАЙЛЫ'],
    accentLine: 1,
    description: 'PDF и фото страниц прямо из домашнего задания.',
    image: 'popup-files.png',
    imageClass: 'shot-files',
    focus: {left: 521, top: 367, width: 208, height: 47},
  },
  {
    id: '04-solution',
    eyebrow: 'ГОТОВОЕ РЕШЕНИЕ',
    title: ['РЕШЕНИЕ', 'С РАЗБОРОМ'],
    accentLine: 1,
    description: 'Можно выбрать короткий ответ или подробное объяснение.',
    image: 'result-clean.png',
    imageClass: 'shot-result',
    hidePointer: true,
    focus: {left: 690, top: 45, width: 156, height: 40},
  },
  {
    id: '05-gdz',
    eyebrow: 'УЧЕБНИКИ И РАБОЧИЕ ТЕТРАДИ',
    title: ['НАХОДИТ', 'ГДЗ'],
    accentLine: 1,
    description: 'По учебнику, странице и номеру задания.',
    image: 'gdz-done.png',
    imageClass: 'shot-gdz',
    focus: {left: 137, top: 94, width: 645, height: 111},
  },
];

const FontGate = ({children}) => {
  const [handle] = useState(() => delayRender('Loading bundled СМЭШ AI fonts'));

  useEffect(() => {
    document.fonts.ready.then(() => continueRender(handle));
  }, [handle]);

  return children;
};

const BrandBackground = ({strong = false}) => (
  <>
    <AbsoluteFill className="paper" />
    <Img
      src={A('brand-background.png')}
      className="generated-background"
      style={{opacity: strong ? 0.58 : 0.20}}
    />
    <div className="edge-rule" />
  </>
);

const BrandLockup = ({large = false}) => (
  <div className={`brand-lockup ${large ? 'brand-lockup-large' : ''}`}>
    <Img src={A('logo-mark.png')} className="brand-mark" />
    <span>СМЭШ AI</span>
  </div>
);

const Pointer = ({focus}) => {
  const endX = 382 + focus.left + 2;
  const endY = 53 + focus.top + focus.height / 2;
  return (
    <svg className="pointer" viewBox="0 0 1280 800" aria-hidden="true">
      <path d={`M 330 532 C 362 532, ${endX - 58} ${endY}, ${endX} ${endY}`} />
      <path d={`M ${endX - 14} ${endY - 9} L ${endX} ${endY} L ${endX - 14} ${endY + 9}`} />
    </svg>
  );
};

const ProductFrame = ({shot}) => (
  <div className="product-frame">
    <Img src={A(shot.image)} className={`product-image ${shot.imageClass}`} />
    {shot.privacyMask ? <div className="privacy-mask" /> : null}
    <div className="focus-box" style={shot.focus} />
  </div>
);

const StoreScreenshot = ({shot}) => (
  <FontGate>
    <AbsoluteFill className="canvas">
      <BrandBackground />
      <BrandLockup />

      <div className="copy-block">
        <div className="eyebrow">{shot.eyebrow}</div>
        <div className="short-rule" />
        <h1>
          {shot.title.map((line, index) => (
            <React.Fragment key={line}>
              <span className={index === shot.accentLine ? 'accent' : ''}>{line}</span>
              {index < shot.title.length - 1 ? <br /> : null}
            </React.Fragment>
          ))}
        </h1>
        <p>{shot.description}</p>
      </div>

      <ProductFrame shot={shot} />
      {shot.hidePointer ? null : <Pointer focus={shot.focus} />}
      <div className="truth-note">Реальный интерфейс СМЭШ AI</div>
    </AbsoluteFill>
  </FontGate>
);

const PromoSmall = () => (
  <FontGate>
    <AbsoluteFill className="promo-small">
      <BrandBackground strong />
      <div className="promo-small-lockup">
        <Img src={A('logo-mark.png')} />
        <span>СМЭШ AI</span>
      </div>
    </AbsoluteFill>
  </FontGate>
);

const PromoMarquee = () => (
  <FontGate>
    <AbsoluteFill className="promo-marquee">
      <BrandBackground strong />
      <div className="marquee-copy">
        <BrandLockup large />
        <h1>Домашка<br />прямо из МЭШ</h1>
        <p>Тесты, файлы и ГДЗ в одном расширении</p>
      </div>
      <div className="marquee-frame">
        <Img src={A('homework-popup.png')} />
      </div>
    </AbsoluteFill>
  </FontGate>
);

const Root = () => (
  <>
    {shots.map((shot) => (
      <Composition
        key={shot.id}
        id={shot.id}
        component={() => <StoreScreenshot shot={shot} />}
        durationInFrames={1}
        fps={30}
        width={1280}
        height={800}
      />
    ))}
    <Composition id="promo-small" component={PromoSmall} durationInFrames={1} fps={30} width={440} height={280} />
    <Composition id="promo-marquee" component={PromoMarquee} durationInFrames={1} fps={30} width={1400} height={560} />
  </>
);

registerRoot(Root);
