import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Brewlytics | A clearer day at your café",
  description: "A simpler way to keep café inventory, orders, and supply requests in sync.",
};

export default function HomePage() {
  return (
    <main className="landing-shell">
      <header className="topbar landing-topbar">
        <a className="wordmark" href="/" aria-label="Brewlytics home">
          <span className="wordmark-mark" aria-hidden="true">B</span>
          <span>Brewlytics</span>
        </a>
        <nav className="topbar-nav" aria-label="Main navigation">
          <a href="/orders">Orders</a>
          <a href="/inventory">Inventory</a>
          <a href="/automated-ordering">AI Forecast</a>
          <a href="/order-requests">Supply requests</a>
        </nav>
        <a className="nav-cta" href="/inventory">Explore workspace</a>
      </header>

      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="hero-copy">
          <p className="hero-eyebrow"><span aria-hidden="true" /> Made for the rhythm of café life</p>
          <h1 id="landing-title">A little more clarity.<br />A lot more <em>coffee.</em></h1>
          <p className="hero-description">
            Keep the moving parts of your café in one warm, welcoming place.
            From stock checks to supply requests, Brewlytics helps the day run smoother.
          </p>
          <div className="hero-actions">
            <a className="primary-button hero-button" href="/inventory">
              Take a look around <span aria-hidden="true">↗</span>
            </a>
            <a className="hero-text-link" href="/orders">View orders</a>
          </div>
          <p className="hero-footnote">Thoughtfully simple tools for your everyday service.</p>
        </div>

        <div className="hero-visual" aria-hidden="true">
          <div className="visual-orbit orbit-one" />
          <div className="visual-orbit orbit-two" />
          <div className="coffee-sun" />
          <div className="coffee-steam steam-one" />
          <div className="coffee-steam steam-two" />
          <div className="coffee-steam steam-three" />
          <div className="coffee-cup">
            <div className="cup-coffee" />
            <div className="cup-sleeve">B</div>
            <div className="cup-handle" />
          </div>
          <div className="visual-shadow" />
          <div className="visual-note note-top">
            <span className="note-dot" />
            <span>Good days start in sync</span>
          </div>
          <div className="visual-note note-bottom">
            <span className="note-icon">✳</span>
            <span>Made for your café</span>
          </div>
        </div>
      </section>

      <section className="landing-features" aria-labelledby="features-title">
        <div className="features-heading">
          <div>
            <p className="eyebrow">THE DAILY POUR</p>
            <h2 id="features-title">Your café, all in one place.</h2>
          </div>
          <p>Less hunting around. More headspace for the things that make your café yours.</p>
        </div>
        <div className="feature-grid">
          <a className="feature-card" href="/inventory">
            <span className="feature-icon inventory-icon" aria-hidden="true">◫</span>
            <span className="feature-card-title">Know what’s in stock</span>
            <span className="feature-card-copy">Keep an eye on ingredients and what needs a top-up.</span>
            <span className="feature-arrow" aria-hidden="true">↗</span>
          </a>
          <a className="feature-card" href="/orders">
            <span className="feature-icon orders-icon" aria-hidden="true">≋</span>
            <span className="feature-card-title">Keep orders together</span>
            <span className="feature-card-copy">Find your café’s order activity in one clear view.</span>
            <span className="feature-arrow" aria-hidden="true">↗</span>
          </a>
          <a className="feature-card" href="/order-requests">
            <span className="feature-icon requests-icon" aria-hidden="true">＋</span>
            <span className="feature-card-title">Stay in the loop</span>
            <span className="feature-card-copy">Give your team a straightforward way to request supplies.</span>
            <span className="feature-arrow" aria-hidden="true">↗</span>
          </a>
        </div>
      </section>

      <footer className="landing-footer">
        <a className="footer-wordmark" href="/">Brewlytics</a>
        <span>A clearer day, one cup at a time.</span>
        <a href="/inventory">Open your workspace <span aria-hidden="true">↗</span></a>
      </footer>
    </main>
  );
}
