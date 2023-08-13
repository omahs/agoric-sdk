import { E, Far } from '@endo/far';

const log = console.log;

export function buildRootObject() {
  let myNickname;

  function makeContact(otherContact, otherNickname) {
    return Far('contact', {
      ping(tag) {
        log(`${myNickname}: pinged with "${tag}", ponging ${otherNickname}`);
        E(otherContact).pong(tag, myNickname);
      },
    });
  }

  return Far('root', {
    setNickname(nickname) {
      myNickname = nickname;
    },
    hello(otherContact, otherNickname) {
      const myContact = makeContact(otherContact, otherNickname);
      E(otherContact).myNameIs(myNickname);
      log(`${myNickname}.hello sees ${otherNickname}`);
      return myContact;
    },
  });
}
