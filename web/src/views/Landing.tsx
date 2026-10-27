import { useEffect, useState } from 'react';
import { PublicFooter } from '../components/publicNav.tsx';

const FEATURES = [
  '공식 패널기반 재구성',
  '다양한 소셜 로그인을 통한 플레이어 관리',
  '이전 매치 기록 및 분석',
  '디스코드 봇을 통한 이벤트 수신 및 관리',
  '강력한 감사 로그 기록',
  '내 서버간 설정 및 플레이어 기록 공유',
];

const CYCLE_MS = 3200;

function RotatingText({ items }: { items: string[] }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setIndex((i) => (i + 1) % items.length), CYCLE_MS);
    return () => clearInterval(t);
  }, [items]);

  return (
    <span className="rotating" aria-hidden="true">
      <span key={index} style={{ animationDuration: `${CYCLE_MS}ms` }}>{items[index]}</span>
    </span>
  );
}

export default function Landing() {
  return (
    <div className="landing">
      <main>
        <h1>Wardogs RCON 패널</h1>
        <p className="muted landing-tagline">
          <RotatingText items={FEATURES} />
          <span className="sr-only">{FEATURES.join(', ')}</span>
        </p>
        <div className="landing-actions">
          <a className="btn btn-primary btn-lg" href="/panel">대시보드로 가기</a>
          <a className="btn btn-lg" href="/panel/demo">데모 서버</a>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
