import Hero from "../components/landing/Hero";
import UploadDemo from "../components/upload/UploadDemo";
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
      <UploadDemo />
      <Features />
      <HowItWorks />
      <ComparisonSection />
      <Trust />
      <Pricing />
      <FinalCTA />
    </>
  );
}
