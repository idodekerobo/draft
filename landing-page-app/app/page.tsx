import LandingPage from "@/components/LandingPage";
import WaitlistModal from "@/components/WaitlistModal";
import { SectionObserver } from "@/components/SectionObserver";

export default function Home() {
  return (
    <main>
      <SectionObserver />
      <LandingPage />
      <WaitlistModal />
    </main>
  );
}
