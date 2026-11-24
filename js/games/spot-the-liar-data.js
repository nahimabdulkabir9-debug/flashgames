// spot-the-liar-data.js: the built-in category/word bank.
// 34 categories, 12 words each. Nothing here is secret until a round starts;
// the host picks one pair and hides the word from the liar in liarSecrets.

export const CATEGORIES = [
  { name: 'Animals', words: ['Lion', 'Tiger', 'Elephant', 'Giraffe', 'Penguin', 'Dolphin', 'Koala', 'Kangaroo', 'Crocodile', 'Butterfly', 'Octopus', 'Unicorn'] },
  { name: 'Countries', words: ['Nigeria', 'Ghana', 'Kenya', 'Brazil', 'Japan', 'Canada', 'France', 'India', 'Egypt', 'Mexico', 'Norway', 'Peru'] },
  { name: 'Cities', words: ['Lagos', 'Cairo', 'London', 'Paris', 'Tokyo', 'Sydney', 'Toronto', 'Dubai', 'Nairobi', 'Madrid', 'Rome', 'Kingston'] },
  { name: 'Foods', words: ['Pizza', 'Burger', 'Sushi', 'Pasta', 'Tacos', 'Curry', 'Samosa', 'Ramen', 'Pancakes', 'Waffles', 'Salad', 'Soup'] },
  { name: 'Desserts', words: ['Cake', 'Ice Cream', 'Chocolate', 'Brownie', 'Cupcake', 'Donut', 'Pie', 'Gelato', 'Pudding', 'Muffin', 'Cookie', 'Tart'] },
  { name: 'Sports', words: ['Football', 'Basketball', 'Tennis', 'Cricket', 'Swimming', 'Boxing', 'Hockey', 'Volleyball', 'Rugby', 'Golf', 'Archery', 'Skating'] },
  { name: 'Movies', words: ['Jumanji', 'Encanto', 'Moana', 'Aladdin', 'Titanic', 'Avatar', 'Inception', 'Matrix', 'Gladiator', 'Jaws', 'Rocky', 'Frozen'] },
  { name: 'Music', words: ['Piano', 'Guitar', 'Drums', 'Violin', 'Trumpet', 'Flute', 'Concert', 'Album', 'Singer', 'Chorus', 'Jazz', 'Reggae'] },
  { name: 'Video Games', words: ['Minecraft', 'Fortnite', 'Tetris', 'Mario', 'Zelda', 'Pokemon', 'Roblox', 'Among Us', 'PUBG', 'FIFA', 'Chess', 'Solitaire'] },
  { name: 'Books', words: ['Novel', 'Poem', 'Comic', 'Atlas', 'Biography', 'Dictionary', 'Encyclopedia', 'Fiction', 'Mystery', 'Thriller', 'Fantasy', 'Romance'] },
  { name: 'Famous People', words: ['Einstein', 'Newton', 'Shakespeare', 'Picasso', 'Mozart', 'Mandela', 'Columbus', 'Galileo', 'Curie', 'Edison', 'Tesla', 'Gandhi'] },
  { name: 'Technology', words: ['Phone', 'Laptop', 'Robot', 'Satellite', 'Internet', 'Browser', 'Password', 'Database', 'Camera', 'Drone', 'Router', 'Printer'] },
  { name: 'Nature', words: ['Mountain', 'Ocean', 'Forest', 'Desert', 'River', 'Waterfall', 'Volcano', 'Canyon', 'Island', 'Beach', 'Cave', 'Glacier'] },
  { name: 'Space', words: ['Planet', 'Star', 'Moon', 'Comet', 'Meteor', 'Galaxy', 'Nebula', 'Orbit', 'Rocket', 'Astronaut', 'Telescope', 'Universe'] },
  { name: 'Vehicles', words: ['Car', 'Bus', 'Train', 'Plane', 'Boat', 'Bicycle', 'Motorcycle', 'Truck', 'Tram', 'Taxi', 'Helicopter', 'Submarine'] },
  { name: 'Colours', words: ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'Pink', 'Brown', 'Black', 'White', 'Silver', 'Gold'] },
  { name: 'Jobs', words: ['Doctor', 'Teacher', 'Chef', 'Pilot', 'Engineer', 'Lawyer', 'Farmer', 'Artist', 'Dentist', 'Nurse', 'Mechanic', 'Actor'] },
  { name: 'Hobbies', words: ['Drawing', 'Painting', 'Reading', 'Cooking', 'Dancing', 'Singing', 'Fishing', 'Gardening', 'Knitting', 'Running', 'Cycling', 'Gaming'] },
  { name: 'Household Items', words: ['Chair', 'Table', 'Lamp', 'Sofa', 'Mirror', 'Clock', 'Broom', 'Bucket', 'Pillow', 'Blanket', 'Kettle', 'Fridge'] },
  { name: 'Clothes', words: ['Shirt', 'Trousers', 'Dress', 'Jacket', 'Sweater', 'Sandals', 'Boots', 'Hat', 'Scarf', 'Gloves', 'Shorts', 'Coat'] },
  { name: 'Weather', words: ['Rain', 'Sunshine', 'Wind', 'Storm', 'Snow', 'Cloud', 'Thunder', 'Lightning', 'Frost', 'Mist', 'Breeze', 'Hail'] },
  { name: 'Body Parts', words: ['Head', 'Hand', 'Foot', 'Eye', 'Ear', 'Nose', 'Mouth', 'Heart', 'Knee', 'Elbow', 'Shoulder', 'Finger'] },
  { name: 'Plants', words: ['Rose', 'Tulip', 'Oak', 'Pine', 'Cactus', 'Fern', 'Lily', 'Bamboo', 'Maple', 'Daisy', 'Orchid', 'Moss'] },
  { name: 'Languages', words: ['English', 'French', 'Spanish', 'Arabic', 'Swahili', 'Hindi', 'Portuguese', 'German', 'Italian', 'Japanese', 'Russian', 'Yoruba'] },
  { name: 'Instruments', words: ['Violin', 'Cello', 'Banjo', 'Harp', 'Saxophone', 'Trombone', 'Keyboard', 'Accordion', 'Ukulele', 'Maracas', 'Xylophone', 'Triangle'] },
  { name: 'Sea Creatures', words: ['Shark', 'Whale', 'Dolphin', 'Seal', 'Crab', 'Lobster', 'Jellyfish', 'Seahorse', 'Starfish', 'Squid', 'Turtle', 'Eel'] },
  { name: 'Birds', words: ['Eagle', 'Parrot', 'Penguin', 'Owl', 'Falcon', 'Peacock', 'Sparrow', 'Pigeon', 'Flamingo', 'Toucan', 'Pelican', 'Robin'] },
  { name: 'Insects', words: ['Ant', 'Bee', 'Wasp', 'Beetle', 'Ladybug', 'Grasshopper', 'Cricket', 'Butterfly', 'Moth', 'Dragonfly', 'Termite', 'Firefly'] },
  { name: 'Drinks', words: ['Water', 'Juice', 'Coffee', 'Tea', 'Soda', 'Milkshake', 'Lemonade', 'Smoothie', 'Cocoa', 'Sprite', 'Fanta', 'Milk'] },
  { name: 'Emotions', words: ['Happy', 'Sad', 'Angry', 'Excited', 'Nervous', 'Proud', 'Jealous', 'Curious', 'Shy', 'Brave', 'Calm', 'Surprised'] },
  { name: 'School Subjects', words: ['Math', 'English', 'Science', 'History', 'Geography', 'Art', 'Music', 'Physics', 'Chemistry', 'Biology', 'French', 'Computer'] },
  { name: 'Tools', words: ['Hammer', 'Screwdriver', 'Wrench', 'Saw', 'Drill', 'Pliers', 'Tape', 'Ruler', 'Chisel', 'Shovel', 'Axe', 'Crowbar'] },
  { name: 'Fruits', words: ['Apple', 'Banana', 'Mango', 'Orange', 'Grape', 'Pineapple', 'Strawberry', 'Peach', 'Pear', 'Watermelon', 'Lemon', 'Cherry'] },
  { name: 'Vegetables', words: ['Carrot', 'Potato', 'Onion', 'Tomato', 'Cucumber', 'Spinach', 'Broccoli', 'Pepper', 'Cabbage', 'Pumpkin', 'Lettuce', 'Beetroot'] },
];

function randomIndex(length) {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % length;
  }
  return Math.floor(Math.random() * length);
}

export const CATEGORY_NAMES = CATEGORIES.map((category) => category.name);
export const wordsFor = (name) => CATEGORIES.find((category) => category.name === name)?.words || CATEGORIES[0].words;
export const randomWord = (name) => {
  const words = wordsFor(name);
  return words[randomIndex(words.length)];
};

/** A random { category, word } pair from the bank. */
export function randomPair() {
  const category = CATEGORIES[randomIndex(CATEGORIES.length)];
  return { category: category.name, word: category.words[randomIndex(category.words.length)] };
}

/** Case/punctuation-insensitive comparison for the liar's final guess. */
export const normalise = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const guessMatches = (guess, word) => Boolean(normalise(guess)) && normalise(guess) === normalise(word);
