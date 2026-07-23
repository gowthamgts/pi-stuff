/**
 * Silicon Valley Extension
 *
 * Shows a random Silicon Valley (HBO) quote whenever a new pi session starts.
 * All quotes are real lines from the show.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const QUOTES = [
  // ── Erlich Bachman ────────────────────────────────────────────────────────
  { text: "Christianity is borderline illegal in Northern California.", author: "Erlich Bachman" },
  { text: "You look like a ferret that gave up on himself six months ago.", author: "Erlich Bachman" },
  { text: "My head is so far up my own ass I can see the future.", author: "Erlich Bachman" },
  { text: "I own 10% of Pied Piper.", author: "Erlich Bachman" },
  { text: "I brought you into my incubator!", author: "Erlich Bachman" },
  { text: "I'm not going to apologize for my process.", author: "Erlich Bachman" },
  { text: "Not now, Jian-Yang, not now!", author: "Erlich Bachman" },
  { text: "Richard, if you're not an asshole, it creates this kind of asshole vacuum and that void is filled by other assholes.", author: "Erlich Bachman" },
  { text: "Richard, a name defines a company. It has to be something primal, something that you can scream out during intercourse.", author: "Erlich Bachman" },
  { text: "I'm gonna come back with a name so amazing that Peter Gregory will write us ten checks.", author: "Erlich Bachman" },

  // ── Bertram Gilfoyle ──────────────────────────────────────────────────────
  { text: "I'm effectively leveraging your misery. I'm like the Warren Buffett of fucking with you.", author: "Bertram Gilfoyle" },
  { text: "I find parades to be impotent displays of authoritarianism.", author: "Bertram Gilfoyle" },
  { text: "Your borders are merely a construct. I prefer to think of myself as a citizen of the world.", author: "Bertram Gilfoyle" },
  { text: "I'm a Satanist. It's a religion of the self.", author: "Bertram Gilfoyle" },
  { text: "It's not magic, it's talent and sweat.", author: "Bertram Gilfoyle" },
  { text: "Dinesh, your code is garbage.", author: "Bertram Gilfoyle" },
  { text: "It is better to rule in hell than serve in a slightly less successful company.", author: "Bertram Gilfoyle" },
  { text: "I can find a flaw in anything. It's my gift.", author: "Bertram Gilfoyle" },
  { text: "I'm a suicide bomber of humiliation.", author: "Bertram Gilfoyle" },
  { text: "You're trying to out-alpha me, Dinesh. It's adorable.", author: "Bertram Gilfoyle" },
  { text: "I am a golden god of system architecture.", author: "Bertram Gilfoyle" },
  { text: "I would rather kill myself than use Windows.", author: "Bertram Gilfoyle" },
  { text: "It's a hardware-defined world, Dinesh.", author: "Bertram Gilfoyle" },

  // ── Dinesh Chugtai ────────────────────────────────────────────────────────
  { text: "I want to be a billionaire so bad it hurts.", author: "Dinesh Chugtai" },
  { text: "All I wanted to do was be a golden millionaire. Is that too much to ask?", author: "Dinesh Chugtai" },
  { text: "Why does everyone think I'm a terrorist?", author: "Dinesh Chugtai" },
  { text: "I look amazing in this leather jacket.", author: "Dinesh Chugtai" },
  { text: "I'm the lead engineer! I matter!", author: "Dinesh Chugtai" },
  { text: "I'm a sex symbol in the tech world.", author: "Dinesh Chugtai" },
  { text: "Hey, Jared, you know who else is Canadian? Justin Bieber, the Hitler of music.", author: "Dinesh Chugtai" },
  { text: "I'm the only one of these clowns that can code in Java.", author: "Dinesh Chugtai" },
  { text: "I write sleek, performant, low-overhead Scala code with higher-order functions that will run on anything. Period. End of sentence.", author: "Dinesh Chugtai" },

  // ── Richard Hendricks ─────────────────────────────────────────────────────
  { text: "We could be the Vikings of our day.", author: "Richard Hendricks" },
  { text: "Kiss my piss.", author: "Richard Hendricks" },
  { text: "I think I just had a panic attack.", author: "Richard Hendricks" },
  { text: "I don't want to build a platform. I want to build a new internet.", author: "Richard Hendricks" },
  { text: "I threw up in a trash can.", author: "Richard Hendricks" },

  // ── Jared Dunn ────────────────────────────────────────────────────────────
  { text: "How much would it be worth to you if I told you I had a GPS app called 'Pied Piper' tracking the location of your child?", author: "Jared Dunn" },
  { text: "My mom never let us eat pizza because she said Italians aren't real white people.", author: "Jared Dunn" },
  { text: "I oughta knock your teeth, you bitch-made motherfucker. I was state-raised!", author: "Jared Dunn" },
  { text: "I've been on the runway before, Richard. There are vultures everywhere.", author: "Jared Dunn" },
  { text: "He turns into a different person at night. He speaks German.", author: "Jared Dunn" },
  { text: "I moved into your garage, Richard. It's quite cozy.", author: "Jared Dunn" },
  { text: "I will pivot this company into a hole in the ground before I let you sell.", author: "Jared Dunn" },
  { text: "Sometimes you have to look a man in the eye and let him know you can kill him.", author: "Jared Dunn" },
  { text: "I know what it's like to be handled. I was in the system until I was 13.", author: "Jared Dunn" },
  { text: "Hey! Standardized testing is a joke!", author: "Jared Dunn" },
  { text: "Oh, I'm fine. I just had a bit of a night terror.", author: "Jared Dunn" },
  { text: "I'm a bit of a neat freak, which is ironic because I used to live in a dumpster.", author: "Jared Dunn" },
  { text: "I'm comfortable with death. I've stared it down many times.", author: "Jared Dunn" },
  { text: "I'm like a proud mother, if the mother had given birth to a tech startup.", author: "Jared Dunn" },
  { text: "I've always been very adept at spinning plates.", author: "Jared Dunn" },
  { text: "I find meaning in the operational details because they are the things that actually keep us alive.", author: "Jared Dunn" },

  // ── Russ Hanneman ─────────────────────────────────────────────────────────
  { text: "These are not the doors of a billionaire, Richard! Fuck you. Fuck you in the ass.", author: "Russ Hanneman" },
  { text: "This guy fucks! I'm looking at the rest of you guys, and this is the guy in the house doing all the fucking. Am I right?", author: "Russ Hanneman" },
  { text: "Tres commas, Richard. Three commas.", author: "Russ Hanneman" },
  { text: "Radio on the Internet.", author: "Russ Hanneman" },
  { text: "Calf skin, Richard. It's luxury.", author: "Russ Hanneman" },

  // ── Gavin Belson ──────────────────────────────────────────────────────────
  { text: "If we can make your audio and video files smaller, we can make cancer smaller. And hunger. And AIDS.", author: "Gavin Belson" },
  { text: "I don't know about you people, but I don't want to live in a world where someone else makes the world a better place better than we do.", author: "Gavin Belson" },
  { text: "Consider the bulldog.", author: "Gavin Belson" },
  { text: "The blood of the young keeps me vital.", author: "Gavin Belson" },
  { text: "I hate Richard Hendricks, that little Pied Piper prick.", author: "Gavin Belson" },

  // ── Jian-Yang ─────────────────────────────────────────────────────────────
  { text: "Eric Bachman, this is your mom, and you are not my baby.", author: "Jian-Yang" },
  { text: "Question for you. What's better than octopus recipe? Answer for you. Eight recipes for octopus.", author: "Jian-Yang" },
  { text: "Not hotdog.", author: "Jian-Yang" },
  { text: "Yes, I eat the fish.", author: "Jian-Yang" },
  { text: "Eric Bachman, is a fat and a poor.", author: "Jian-Yang" },
  { text: "Mike Hunt. Nice to meet you.", author: "Jian-Yang" },

  // ── Peter Gregory ─────────────────────────────────────────────────────────
  { text: "And now, would anyone like some BK?", author: "Peter Gregory" },

  // ── Laurie Bream ──────────────────────────────────────────────────────────
  { text: "Peter Gregory is dead.", author: "Laurie Bream" },
  { text: "Monica, Peter Gregory is dead.", author: "Laurie Bream" },
  { text: "This is a sub-optimal outcome.", author: "Laurie Bream" },
  { text: "I am experiencing a lack of enthusiasm.", author: "Laurie Bream" },

  // ── Big Head ──────────────────────────────────────────────────────────────
  { text: "I just kind of float around and get paid.", author: "Big Head" },
  { text: "I think I'm a co-CEO now?", author: "Big Head" },
  { text: "I like Big Gulp.", author: "Big Head" },
  { text: "I failed upwards.", author: "Big Head" },
];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload") return;

    const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    ctx.ui.notify(`💬 "${quote.text}" — ${quote.author}`, "info");
  });
}
