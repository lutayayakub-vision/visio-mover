import Hero from "../components/landing/Hero";
import UploadSection from "../components/upload/UploadSection";
import Features from "../components/landing/Features";
import HowItWorks from "../components/landing/HowItWorks";
import ComparisonSection from "../components/landing/ComparisonSection";
import Trust from "../components/landing/Trust";
import Pricing from "../components/landing/Pricing";
import FinalCTA from "../components/landing/FinalCTA";

export default function Landing() {
  return (
    <>
      <Hero />
      <UploadSection />
      <Features />
      <HowItWorks />
      <ComparisonSection />
      <Trust />
      <Pricing />
      <FinalCTA />
    </>
  );
}
